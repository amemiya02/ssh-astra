import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Dialog } from "@/components/ui/dialog";
import { startI18n } from "@/i18n";
import type { Host } from "@/lib/ipc/hosts";
import { HostFormDialogContent } from "./HostDialogs";

type EditorProps = ComponentProps<typeof HostFormDialogContent>;

const host: Host = {
  id: "prod",
  name: "Production",
  address: "prod.local",
  port: 22,
  user: "deploy",
  auth: { type: "password" },
  jumpHost: null,
  groupId: null,
  forwards: [],
  terminalScheme: "ember",
  defaultDirectory: "/srv/app",
};

let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  startI18n();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderEditor(props: Partial<EditorProps> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <Dialog open>
        <HostFormDialogContent
          host={host}
          hosts={[]}
          save={vi.fn(async () => host)}
          onSaved={vi.fn()}
          onCancel={vi.fn()}
          {...props}
        />
      </Dialog>,
    );
  });
}

const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((item) => item.textContent === name)!;

const field = (name: string) =>
  [...document.querySelectorAll<HTMLLabelElement>('[role="dialog"] label')].find((label) => label.textContent === name)!.control!;

describe("Host editor", () => {
  it("shows the connection fields by default and lets the user toggle advanced options", async () => {
    await renderEditor({ groupName: "Infrastructure" });

    const advanced = button("Advanced");
    const directory = field("File panel folder");
    expect(field("Jump host").closest("[hidden]")).toBeNull();
    expect(document.querySelector('[role="dialog"] dd')?.textContent).toBe("Infrastructure");
    expect(advanced?.getAttribute("aria-expanded")).toBe("false");
    expect(directory.closest("[hidden]")).not.toBeNull();

    act(() => advanced.click());
    expect(advanced.getAttribute("aria-expanded")).toBe("true");
    expect(directory.closest("[hidden]")).toBeNull();
    expect(field("Terminal colours").closest("[hidden]")).toBeNull();

    act(() => advanced.click());
    expect(advanced.getAttribute("aria-expanded")).toBe("false");
    expect(directory.closest("[hidden]")).not.toBeNull();
  });

  it.each([false, true])("opens Identities only in Advanced and saves when toggled from %s", async (enabled) => {
    const keyHost: Host = {
      ...host,
      auth: { type: "key", identityFile: "~/.ssh/build" },
      identitiesOnly: enabled,
    };
    const save = vi.fn<EditorProps["save"]>().mockResolvedValue(keyHost);
    await renderEditor({ host: keyHost, save });

    const identitiesOnly = field("Identities only");
    expect(identitiesOnly.closest("[hidden]")).not.toBeNull();
    act(() => button("Advanced").click());
    expect(identitiesOnly.closest("[hidden]")).toBeNull();
    expect(identitiesOnly.getAttribute("aria-checked")).toBe(String(enabled));

    act(() => identitiesOnly.click());
    await act(async () => button("Save").click());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ identitiesOnly: !enabled }), "prod");
  });

  it.each([undefined, true])("shows the agent-forwarding risk in Advanced and saves when toggled from %s", async (enabled) => {
    const save = vi.fn<EditorProps["save"]>().mockResolvedValue(host);
    await renderEditor({ host: { ...host, forwardAgent: enabled }, save });

    act(() => button("Advanced").click());
    const forwardAgent = field("Agent forwarding");
    expect(forwardAgent.closest("[hidden]")).toBeNull();
    expect(forwardAgent.getAttribute("aria-checked")).toBe(String(enabled ?? false));
    expect(document.getElementById(forwardAgent.getAttribute("aria-describedby")!)?.textContent)
      .toBe("While connected, the remote host can use your SSH keys through your local agent. Reconnect to apply changes.");

    act(() => forwardAgent.click());
    await act(async () => button("Save").click());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ forwardAgent: !enabled }), "prod");
  });

  it.each([
    ["defaultDirectory", "File panel folder"],
    ["terminalScheme", "Terminal colours"],
  ])("opens Advanced and focuses the rejected %s field on save", async (rejectedField, label) => {
    const save = vi.fn<EditorProps["save"]>().mockRejectedValue({
      kind: "invalid",
      message: "Choose a valid value",
      details: { field: rejectedField },
    });
    await renderEditor({ save });

    await act(async () => button("Save").click());

    const control = field(label);
    expect(button("Advanced").getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(control);
    expect(control.getAttribute("aria-invalid")).toBe("true");
    const messageId = document.querySelector('[role="alert"]')?.id;
    expect(control.getAttribute("aria-describedby")?.split(" ")).toContain(messageId);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Choose a valid value");
  });

  it.each([[undefined, "0", 0], [15, "", undefined]] as const)(
    "edits the keepalive interval in Advanced from %s to %s",
    async (previous, next, expected) => {
      const save = vi.fn<EditorProps["save"]>().mockResolvedValue(host);
      await renderEditor({ host: { ...host, keepaliveSeconds: previous }, save });

      const input = field("Keepalive interval (seconds)") as HTMLInputElement;
      expect(input.closest("[hidden]")).not.toBeNull();
      act(() => button("Advanced").click());
      expect(input.value).toBe(previous === undefined ? "" : String(previous));
      act(() => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setValue.call(input, next);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      act(() => button("Advanced").click());
      await act(async () => button("Save").click());

      expect(save).toHaveBeenCalledOnce();
      expect(save.mock.calls[0]?.[0].keepaliveSeconds).toBe(expected);
    },
  );

  it("saves the post-login command from Advanced, including leading shell whitespace", async () => {
    const save = vi.fn<EditorProps["save"]>().mockResolvedValue(host);
    await renderEditor({ save });

    const input = field("Post-login command") as HTMLInputElement;
    expect(input.closest("[hidden]")).not.toBeNull();
    act(() => button("Advanced").click());

    const command = " printf '%s' \"$HOME\"";
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, command);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Save").click());

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ postLoginCommand: command }), "prod");
  });

  it("opens Terminal charset and Backspace settings in Advanced and saves the selected values", async () => {
    const save = vi.fn<EditorProps["save"]>().mockResolvedValue(host);
    await renderEditor({ host: { ...host, terminalCharset: "big5" }, save });

    const charset = field("Terminal character set");
    const backspace = field("Backspace sends");
    expect(charset.closest("[hidden]")).not.toBeNull();
    expect(backspace.closest("[hidden]")).not.toBeNull();
    act(() => button("Advanced").click());
    expect(charset.textContent).toBe("Big5");
    expect(backspace.textContent).toBe("DEL");

    function choose(control: HTMLElement, label: string) {
      act(() => control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((item) => item.textContent === label)!;
      act(() => option.click());
    }

    choose(charset, "GBK");
    choose(backspace, "Ctrl-H");
    await act(async () => button("Save").click());
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ terminalCharset: "gbk", terminalBackspace: "ctrlH" }),
      "prod",
    );
  });

  it("saves edits to both advanced fields after the section is collapsed again", async () => {
    const save = vi.fn<EditorProps["save"]>().mockResolvedValue(host);
    await renderEditor({ save });

    act(() => button("Advanced").click());
    act(() => {
      const directory = field("File panel folder");
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(directory, " ~/release ");
      directory.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => field("Terminal colours").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const dark = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "Astra Dark")!;
    act(() => dark.click());
    act(() => button("Advanced").click());
    await act(async () => button("Save").click());

    expect(save).toHaveBeenCalledWith({
      name: "Production",
      address: "prod.local",
      port: 22,
      user: "deploy",
      auth: { type: "password" },
      jumpHost: null,
      terminalScheme: "dark",
      defaultDirectory: "~/release",
      identitiesOnly: false,
      forwardAgent: false,
    }, "prod");
  });
});
