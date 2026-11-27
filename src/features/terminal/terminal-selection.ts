export const selectAllEvent = "sshastra-select-all";

/** The Terminal can select scrollback. WebKit selects text in ordinary inputs. */
export function selectAll(): void {
  const event = new Event(selectAllEvent, { bubbles: true, cancelable: true });
  if (document.activeElement?.dispatchEvent(event) !== false) document.execCommand("selectAll");
}
