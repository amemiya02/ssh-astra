use std::cell::Cell;

use serde_json::{json, Value};
use sshastra_core::agent::{
    dispatch, AgentPermission, OpenTerminal, TerminalOrigin, TerminalStatus,
};

fn list(enabled: bool, snapshot: impl FnOnce() -> Vec<OpenTerminal>) -> Value {
    let request =
        br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_terminals"}}"#;
    let response = dispatch(request, enabled, snapshot).unwrap();
    assert_eq!(response["id"], 1);
    serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

fn terminal(id: u64, origin: TerminalOrigin) -> OpenTerminal {
    OpenTerminal {
        id: id.into(),
        origin,
        title: Some("shell".into()),
        cwd: Some("/srv/test".into()),
        status: TerminalStatus::Connected,
    }
}

fn saved(id: &str, permission: AgentPermission) -> TerminalOrigin {
    TerminalOrigin::Saved {
        name: id.into(),
        permission,
    }
}

#[test]
fn lists_only_terminals_on_opted_in_saved_hosts() {
    let off = list(false, || {
        panic!("a disabled service must never read metadata")
    });
    assert_eq!(off, json!({"terminals":[]}));
    let live_permission = Cell::new(AgentPermission::Read);
    let snapshot = || {
        vec![
            terminal(1, TerminalOrigin::Local),
            terminal(2, TerminalOrigin::Temporary),
            terminal(3, saved("private", AgentPermission::Off)),
            terminal(4, saved("build", live_permission.get())),
            terminal(5, saved("staging", AgentPermission::Approval)),
        ]
    };
    assert_eq!(
        list(true, snapshot),
        json!({"terminals": [
            {"id":4,"host":"build","title":"shell","cwd":"/srv/test","status":"connected"},
            {"id":5,"host":"staging","title":"shell","cwd":"/srv/test","status":"connected"},
        ]})
    );
    live_permission.set(AgentPermission::Off);
    assert_eq!(list(true, snapshot)["terminals"][0]["id"], 5);
}

#[test]
fn advertises_only_the_metadata_tool() {
    let request = br#"{"jsonrpc":"2.0","id":"mcp","method":"tools/list"}"#;
    let response = dispatch(request, true, Vec::new).unwrap();
    assert_eq!(response["id"], "mcp");
    assert_eq!(response["result"]["tools"].as_array().unwrap().len(), 1);
    assert_eq!(response["result"]["tools"][0]["name"], "list_terminals");

    let request =
        br#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"write_file"}}"#;
    assert_eq!(
        dispatch(request, true, Vec::new).unwrap()["error"]["code"],
        -32602
    );
}
