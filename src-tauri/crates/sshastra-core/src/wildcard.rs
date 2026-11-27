/// Match a complete string with Unicode-aware `*` and `?` wildcards.
pub(crate) fn matches(pattern: &[char], name: &str) -> bool {
    let name: Vec<char> = name.chars().collect();
    let (mut p, mut n) = (0, 0);
    let mut backtrack: Option<(usize, usize)> = None;
    while n < name.len() {
        match pattern.get(p) {
            Some('*') => {
                backtrack = Some((p, n));
                p += 1;
            }
            Some(&c) if c == '?' || c == name[n] => {
                p += 1;
                n += 1;
            }
            _ => match backtrack {
                Some((star, matched)) => {
                    p = star + 1;
                    n = matched + 1;
                    backtrack = Some((star, matched + 1));
                }
                None => return false,
            },
        }
    }
    pattern[p..].iter().all(|&c| c == '*')
}
