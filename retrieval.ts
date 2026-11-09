// Grounding from Selene Retrieval: a small MCP stdio client (newline-delimited JSON-RPC) to the
// same bridge Pi's mcp.json starts. Extension commands cannot call Pi tools, so the extension
// talks to the bridge itself, once per enhancement.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { EnhancerConfig } from "./config.ts";
import type { Section } from "./session.ts";

export interface BridgeCommand {
  command: string;
  args: string[];
}

/** The bridge command: settings first, then the `selene-retrieval` entry of Pi's mcp.json. */
export function resolveBridge(cfg: EnhancerConfig, mcpJson = join(homedir(), ".pi", "agent", "mcp.json")): BridgeCommand | null {
  if (cfg.retrieval.command) return { command: cfg.retrieval.command, args: cfg.retrieval.args ?? [] };
  try {
    const servers = JSON.parse(readFileSync(mcpJson, "utf8").replace(/^\uFEFF/, ""))?.mcpServers ?? {};
    const s = servers["selene-retrieval"] ?? servers.selene_retrieval;
    if (s && typeof s.command === "string") return { command: s.command, args: Array.isArray(s.args) ? s.args : [] };
  } catch {}
  const local = process.env.LOCALAPPDATA;
  return local ? { command: join(local, "Selene Retrieval", "sr-bridge.exe"), args: ["--client", "other"] } : null;
}

export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
  } else child.kill("SIGKILL");
}

export class McpClient {
  private child: ChildProcess;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private closed = false;

  constructor(cmd: BridgeCommand) {
    this.child = spawn(cmd.command, cmd.args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    this.child.on("error", (e) => this.failAll(e));
    this.child.on("exit", () => this.failAll(new Error("Selene Retrieval bridge exited")));
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const p = msg && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
  }

  private failAll(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.closed = true;
  }

  private send(obj: object) {
    if (!this.closed) this.child.stdin!.write(`${JSON.stringify(obj)}\n`);
  }

  request(method: string, params: object): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Selene Retrieval bridge is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pi-prompt-enhancer", version: "1.0.0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** `tools/call`; the structured content when present, else the first text block. */
  async call(name: string, args: object): Promise<any> {
    const r = await this.request("tools/call", { name, arguments: args });
    if (r?.isError) throw new Error(r?.content?.[0]?.text ?? `${name} failed`);
    return r?.structuredContent ?? r?.content?.[0]?.text ?? null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin!.end();
    } catch {}
    killTree(this.child);
  }
}

/** Runs `fn` with a connected client; null when the bridge is missing, slow or fails. */
export async function withRetrieval<T>(
  cfg: EnhancerConfig,
  signal: AbortSignal | undefined,
  fn: (c: McpClient) => Promise<T>,
): Promise<{ value: T | null; error: string | null }> {
  const cmd = resolveBridge(cfg);
  if (!cmd) return { value: null, error: "Selene Retrieval is not installed" };
  const client = new McpClient(cmd);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => client.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${cfg.retrieval.timeoutSeconds} s`)), cfg.retrieval.timeoutSeconds * 1000);
    });
    const value = await Promise.race([client.initialize().then(() => fn(client)), timeout]);
    return { value, error: null };
  } catch (e) {
    return { value: null, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    client.close();
  }
}

export interface Folder {
  folder_id: string;
  name: string;
  path: string;
}

const norm = (p: string) => resolve(p).toLowerCase().replace(/[\\/]+$/, "");
const within = (child: string, parent: string) => child === parent || child.startsWith(parent + sep.toLowerCase()) || child.startsWith(`${parent}/`);

/** Indexed folders that contain one of `roots`, or that one of `roots` contains. */
export function scopeFolders(folders: Folder[], roots: string[]): Folder[] {
  const rs = roots.map(norm);
  return folders.filter((f) => {
    const fp = norm(f.path);
    return rs.some((r) => within(r, fp) || within(fp, r));
  });
}

export interface Hit {
  path: string;
  line_start: number;
  line_end: number;
  snippet: string;
}

/**
 * Every hit, whole: no total or per-snippet limit here. Selene Retrieval itself returns at most
 * `maxResults` hits (cap 150) and cuts a snippet longer than 4,000 characters (it then ends
 * with "…").
 */
export function retrievalSection(hits: Hit[], folderNames: string[], note: string): Section {
  const parts = hits.map((h) => `#### ${h.path}:${h.line_start}-${h.line_end}\n${h.snippet.trim()}`);
  return {
    key: "retrieval",
    tag: "retrieved_context",
    note: `${note}${folderNames.length ? ` (indexed folder: ${folderNames.join(", ")})` : ""}; use these exact paths and names`,
    text: parts.join("\n\n"),
    items: parts.length,
    omitted: 0,
  };
}

/**
 * Search query: the whole draft, whitespace collapsed (no length limit here). Selene Retrieval
 * refuses a query over 8,192 bytes ("query is too long"); its vector search embeds the first 512
 * tokens of the query, keyword search uses every word.
 */
export function queryOf(draft: string): string {
  return draft.replace(/\s+/g, " ").trim();
}

export interface Grounding {
  section: Section | null;
  folderIds: string[];
  error: string | null;
}

/** Folder scoping plus one hybrid search for the draft. */
export async function ground(cfg: EnhancerConfig, draft: string, roots: string[], signal?: AbortSignal): Promise<Grounding> {
  if (!cfg.retrieval.enabled) return { section: null, folderIds: [], error: "retrieval is turned off" };
  const r = await withRetrieval(cfg, signal, async (c) => {
    const listed = await c.call("list_folders", {});
    const folders: Folder[] = Array.isArray(listed?.folders) ? listed.folders : [];
    const scoped = scopeFolders(folders, roots);
    if (!scoped.length) return { scoped, hits: [] as Hit[] };
    const res = await c.call("context_search", {
      query: queryOf(draft),
      maxResults: cfg.retrieval.maxResults,
      folderIds: scoped.map((f) => f.folder_id),
    });
    return { scoped, hits: (Array.isArray(res?.hits) ? res.hits : []) as Hit[] };
  });
  if (!r.value) return { section: null, folderIds: [], error: r.error };
  const { scoped, hits } = r.value;
  if (!scoped.length) return { section: null, folderIds: [], error: "this checkout is not in an indexed folder" };
  return {
    folderIds: scoped.map((f) => f.folder_id),
    error: null,
    section: retrievalSection(hits, scoped.map((f) => f.name), "code and docs that match the draft"),
  };
}
