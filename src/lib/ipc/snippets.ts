import { invoke } from "@tauri-apps/api/core";
import type { HostId } from "./hosts";

export type SnippetId = string;

export interface SnippetDraft {
  name: string;
  command: string;
  group: string | null;
  hostIds: HostId[];
  sendEnter: boolean;
}

export interface Snippet extends SnippetDraft {
  id: SnippetId;
}

export interface SnippetImportReport {
  added: Snippet[];
  skipped: string[];
}

export function listSnippets(): Promise<Snippet[]> {
  return invoke("snippets_list");
}

export function saveSnippet(draft: SnippetDraft, id?: SnippetId): Promise<Snippet> {
  return invoke("snippet_save", { draft, id });
}

export function deleteSnippet(id: SnippetId): Promise<void> {
  return invoke("snippet_delete", { id });
}

export function exportSnippets(path: string): Promise<void> {
  return invoke("snippets_export", { path });
}

export function importSnippets(path: string): Promise<SnippetImportReport> {
  return invoke("snippets_import", { path });
}
