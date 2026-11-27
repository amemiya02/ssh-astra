use encoding_rs::{CoderResult, Decoder, EncoderResult, Encoding, BIG5, GBK};
use serde::{Deserialize, Serialize};

/// The character set of a remote Terminal's byte stream.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalCharset {
    #[default]
    Utf8,
    Gbk,
    Big5,
    Latin1,
}

/// What the Terminal sends when Backspace is pressed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalBackspace {
    #[default]
    Del,
    CtrlH,
}

impl TerminalCharset {
    /// Latin-1 maps every byte to the matching Unicode code point. The WHATWG
    /// Latin-1 labels resolve to Windows-1252 in encoding_rs.
    fn legacy_encoding(self) -> Option<&'static Encoding> {
        match self {
            Self::Gbk => Some(GBK),
            Self::Big5 => Some(BIG5),
            Self::Utf8 | Self::Latin1 => None,
        }
    }

    /// Converts UTF-8 typed or pasted in the Terminal into shell bytes.
    pub(crate) fn encode_input(self, input: &[u8]) -> Vec<u8> {
        if self == Self::Utf8 || input.is_ascii() {
            return input.to_vec();
        }
        let input = String::from_utf8_lossy(input);
        match self.legacy_encoding() {
            Some(encoding) => encode_legacy(encoding, &input),
            None => input
                .chars()
                .map(|ch| u8::try_from(ch).unwrap_or(b'?'))
                .collect(),
        }
    }

    /// Decodes a complete command reported by Shell integration.
    pub(crate) fn decode_command(self, input: &[u8]) -> String {
        match self.legacy_encoding() {
            Some(encoding) => encoding.decode_without_bom_handling(input).0.into_owned(),
            None if self == Self::Latin1 => input.iter().copied().map(char::from).collect(),
            None => String::from_utf8_lossy(input).into_owned(),
        }
    }
}

fn encode_legacy(encoding: &'static Encoding, mut input: &str) -> Vec<u8> {
    let mut encoder = encoding.new_encoder();
    let mut output = Vec::with_capacity(input.len());
    loop {
        let (result, read) =
            encoder.encode_from_utf8_to_vec_without_replacement(input, &mut output, true);
        input = &input[read..];
        match result {
            EncoderResult::InputEmpty => return output,
            EncoderResult::Unmappable(_) => output.push(b'?'),
            EncoderResult::OutputFull => output.reserve(input.len().saturating_add(4)),
        }
    }
}

/// One shell's streaming conversion to the Terminal's UTF-8 output.
pub(crate) struct OutputDecoder {
    charset: TerminalCharset,
    legacy: Option<Decoder>,
}

impl OutputDecoder {
    pub(crate) fn new(charset: TerminalCharset) -> Self {
        Self {
            charset,
            legacy: charset
                .legacy_encoding()
                .map(Encoding::new_decoder_without_bom_handling),
        }
    }

    pub(crate) fn decode(&mut self, bytes: Vec<u8>, last: bool) -> Vec<u8> {
        if let Some(decoder) = &mut self.legacy {
            let mut output =
                String::with_capacity(decoder.max_utf8_buffer_length(bytes.len()).unwrap());
            let (result, read, _) = decoder.decode_to_string(&bytes, &mut output, last);
            debug_assert_eq!(result, CoderResult::InputEmpty);
            debug_assert_eq!(read, bytes.len());
            return output.into_bytes();
        }
        if self.charset == TerminalCharset::Latin1 && !bytes.is_ascii() {
            return bytes
                .into_iter()
                .map(char::from)
                .collect::<String>()
                .into_bytes();
        }
        bytes
    }
}
