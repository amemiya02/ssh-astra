use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

use chrono::{DateTime, Utc};
use encoding_rs::{CoderResult, Decoder, UTF_8};
use serde::Serialize;

use super::output::{create_output_file, MAX_OUTPUT_CHUNK};
use super::TerminalSize;

#[derive(Serialize)]
struct Header {
    version: u8,
    width: u16,
    height: u16,
    timestamp: i64,
}

pub(super) struct RecordingWriter {
    pub(super) path: PathBuf,
    file: File,
    started: Instant,
    decoder: Decoder,
    text: String,
    line: Vec<u8>,
}

impl RecordingWriter {
    pub(super) fn new(directory: &Path, host: &str, size: TerminalSize) -> io::Result<Self> {
        let timestamp = DateTime::<Utc>::from(SystemTime::now());
        let (path, file) = create_output_file(directory, host, timestamp, "cast")?;
        let mut writer = Self {
            path,
            file,
            started: Instant::now(),
            decoder: UTF_8.new_decoder_without_bom_handling(),
            text: String::new(),
            line: Vec::new(),
        };
        write_line(
            &mut writer.file,
            &mut writer.line,
            &Header {
                version: 2,
                width: size.cols,
                height: size.rows,
                timestamp: timestamp.timestamp(),
            },
        )?;
        Ok(writer)
    }

    pub(super) fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        let time = self.started.elapsed().as_secs_f64();
        for chunk in bytes.chunks(MAX_OUTPUT_CHUNK) {
            self.write_output(time, chunk, false)?;
        }
        Ok(())
    }

    pub(super) fn resize(&mut self, size: TerminalSize) -> io::Result<()> {
        let time = self.started.elapsed().as_secs_f64();
        let dimensions = format!("{}x{}", size.cols, size.rows);
        write_line(&mut self.file, &mut self.line, &(time, "r", dimensions))
    }

    pub(super) fn finish_stream(&mut self) -> io::Result<()> {
        let time = self.started.elapsed().as_secs_f64();
        self.write_output(time, &[], true)?;
        self.decoder = UTF_8.new_decoder_without_bom_handling();
        Ok(())
    }

    fn write_output(&mut self, time: f64, bytes: &[u8], last: bool) -> io::Result<()> {
        // The cast uses UTF-8 JSON strings. Keep incomplete code points across
        // chunks, and let the decoder replace malformed bytes with U+FFFD.
        self.text.clear();
        self.text
            .reserve(self.decoder.max_utf8_buffer_length(bytes.len()).unwrap());
        let (result, read, _) = self.decoder.decode_to_string(bytes, &mut self.text, last);
        debug_assert_eq!(result, CoderResult::InputEmpty);
        debug_assert_eq!(read, bytes.len());
        if !self.text.is_empty() {
            write_line(&mut self.file, &mut self.line, &(time, "o", &self.text))?;
        }
        Ok(())
    }
}

fn write_line(file: &mut File, line: &mut Vec<u8>, value: &impl Serialize) -> io::Result<()> {
    // Serialize into one bounded buffer and append each complete event with a
    // single write in the usual case. Playback can read the file as it grows.
    line.clear();
    serde_json::to_writer(&mut *line, value)?;
    line.push(b'\n');
    file.write_all(line)
}
