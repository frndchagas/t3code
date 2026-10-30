// @effect-diagnostics nodeBuiltinImport:off -- Exercise the native lookup's subprocess transport without a desktop session.
import * as NodeStream from "node:stream";
import { assert, beforeEach, expect, it, vi } from "vite-plus/test";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { activeWindow } from "./ActiveWindow.ts";

const { execFile, ChildProcess: NativeChildProcess } =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");

beforeEach(() => {
  execFileMock.mockReset();
});

function stubMacLookup(stdout: string) {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: ReadonlyArray<string>,
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      callback(null, stdout);
      return {};
    },
  );
}

function macLookup(
  windows: ReadonlyArray<{
    id: number;
    title: string;
    bounds: { x: number; y: number; width: number; height: number };
    alpha?: number;
  }>,
) {
  return JSON.stringify({
    owner: {
      name: "Editor",
      processId: 123,
      path: "/Applications/Editor.app",
      bundleId: "com.example.editor",
    },
    windows: windows.map((window) => ({ ...window, alpha: window.alpha ?? 1 })),
  });
}

it("parses the frontmost macOS window from the osascript lookup", async () => {
  stubMacLookup(
    macLookup([
      {
        id: 42,
        title: "main.ts",
        bounds: { x: 10, y: 20, width: 800, height: 600 },
      },
    ]) + "\n",
  );

  const window = await activeWindow("darwin");

  assert.deepEqual(window, {
    platform: "macos",
    id: 42,
    title: "main.ts",
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    owner: {
      name: "Editor",
      processId: 123,
      path: "/Applications/Editor.app",
      bundleId: "com.example.editor",
    },
  });
  const [file, args] = execFileMock.mock.calls[0]!;
  assert.strictEqual(file, "/usr/bin/osascript");
  assert.deepEqual(args.slice(0, 3), ["-l", "JavaScript", "-"]);
});

it.each([
  {
    name: "transparent and untitled helpers",
    helpers: [
      {
        id: 1,
        title: "",
        bounds: { x: -1, y: -44, width: 1_680, height: 44 },
        alpha: 0,
      },
      { id: 2, title: "", bounds: { x: 0, y: 0, width: 1_680, height: 68 } },
    ],
    content: {
      id: 3,
      title: "Document",
      bounds: { x: 0, y: 0, width: 1_680, height: 1_050 },
    },
  },
  {
    name: "Chrome strips stacked above the content window",
    helpers: [
      { id: 75, title: "", bounds: { x: 0, y: 39, width: 1_800, height: 41 } },
      { id: 74, title: "", bounds: { x: 0, y: 80, width: 1_800, height: 81 } },
      { id: 1691, title: "", bounds: { x: 0, y: 39, width: 1_800, height: 158 } },
    ],
    content: {
      id: 71,
      title: "(10) Video - YouTube",
      bounds: { x: 0, y: 161, width: 1_800, height: 1_008 },
    },
  },
  {
    name: "vertical strips at a negative desktop origin",
    helpers: [
      { id: 1, title: "", bounds: { x: -122, y: -100, width: 41, height: 1_000 } },
      { id: 2, title: "", bounds: { x: -81, y: -100, width: 81, height: 1_000 } },
    ],
    content: {
      id: 3,
      title: "Document",
      bounds: { x: 0, y: -100, width: 1_008, height: 1_000 },
    },
  },
  {
    name: "a smaller front window's strips with a larger background window",
    helpers: [
      { id: 75, title: "", bounds: { x: 100, y: 139, width: 1_200, height: 41 } },
      { id: 74, title: "", bounds: { x: 100, y: 180, width: 1_200, height: 81 } },
    ],
    content: {
      id: 71,
      title: "Video - YouTube",
      bounds: { x: 100, y: 261, width: 1_200, height: 700 },
    },
    background: [
      { id: 80, title: "Other document", bounds: { x: 0, y: 39, width: 1_800, height: 1_130 } },
    ],
  },
])("selects the content window behind $name", async ({ helpers, content, background = [] }) => {
  stubMacLookup(macLookup([...helpers, content, ...background]));

  const window = await activeWindow("darwin");

  assert.strictEqual(window?.id, content.id);
  assert.deepEqual(window?.bounds, content.bounds);
});

it.each([
  { name: "untitled dialog", title: "", bounds: { x: 300, y: 200, width: 400, height: 240 } },
  { name: "titled palette", title: "Palette", bounds: { x: 0, y: 0, width: 800, height: 50 } },
  { name: "offset untitled strip", title: "", bounds: { x: 100, y: 100, width: 800, height: 50 } },
  { name: "tall untitled window", title: "", bounds: { x: 0, y: 0, width: 800, height: 900 } },
  {
    name: "horizontal strip below the document",
    title: "",
    bounds: { x: 0, y: 1_200, width: 800, height: 50 },
  },
  {
    name: "horizontal strip inside the document",
    title: "",
    bounds: { x: 0, y: 600, width: 800, height: 50 },
  },
  {
    name: "horizontal strip far above the document",
    title: "",
    bounds: { x: 0, y: -300, width: 800, height: 50 },
  },
  {
    name: "vertical strip right of the document",
    title: "",
    bounds: { x: 900, y: 0, width: 50, height: 1_000 },
  },
  {
    name: "vertical strip inside the document",
    title: "",
    bounds: { x: 400, y: 0, width: 50, height: 1_000 },
  },
  {
    name: "vertical strip far left of the document",
    title: "",
    bounds: { x: -250, y: 0, width: 50, height: 1_000 },
  },
])("keeps a frontmost $name ahead of a larger document", async ({ title, bounds }) => {
  stubMacLookup(
    macLookup([
      { id: 1, title, bounds },
      { id: 2, title: "Document", bounds: { x: 0, y: 0, width: 800, height: 1_000 } },
    ]),
  );

  const window = await activeWindow("darwin");

  assert.strictEqual(window?.id, 1);
  assert.deepEqual(window?.bounds, bounds);
});

it("keeps an untitled content window ahead of a much taller background window", async () => {
  const bounds = { x: 0, y: 0, width: 800, height: 900 };
  stubMacLookup(
    macLookup([
      { id: 1, title: "", bounds },
      { id: 2, title: "Background document", bounds: { x: 0, y: 0, width: 800, height: 4_000 } },
    ]),
  );

  const window = await activeWindow("darwin");

  assert.strictEqual(window?.id, 1);
  assert.deepEqual(window?.bounds, bounds);
});

it("finds the macOS window when the script consumer limits argument length", async () => {
  const consumer = `
    if (process.argv.slice(1).some((arg) => Buffer.byteLength(arg) > 1024)) {
      process.stderr.write("argument exceeds the launcher's length limit");
      process.exit(64);
    }
    let script = "";
    for await (const chunk of process.stdin) script += chunk;
    if (!script.trim()) throw new Error("No script received");
    process.stdout.write(JSON.stringify({
      owner: { name: "Editor", processId: 123, path: "/Applications/Editor.app", bundleId: "com.example.editor" },
      windows: [{ id: 42, title: "Editor", bounds: { x: 10, y: 20, width: 800, height: 600 }, alpha: 1 }]
    }));
  `;
  using children = new DisposableStack();
  execFileMock
    .mockReset()
    .mockImplementation((_file, args, options, callback) =>
      children.use(
        execFile(
          process.execPath,
          ["--input-type=module", "-e", consumer, "--", ...args],
          { ...options, encoding: "utf8" },
          callback,
        ),
      ),
    );

  await expect(activeWindow("darwin")).resolves.toEqual({
    platform: "macos",
    id: 42,
    title: "Editor",
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    owner: {
      name: "Editor",
      processId: 123,
      path: "/Applications/Editor.app",
      bundleId: "com.example.editor",
    },
  });
});

it("rejects a broken input pipe without an unhandled stream error", async () => {
  const error = Object.assign(new Error("input pipe closed"), { code: "EPIPE" });
  const child = new NativeChildProcess();
  child.stdin = new NodeStream.Writable({
    write(_chunk, _encoding, callback) {
      callback(error);
    },
  });
  execFileMock.mockReset().mockReturnValue(child);

  await expect(activeWindow("darwin")).rejects.toBe(error);
});
