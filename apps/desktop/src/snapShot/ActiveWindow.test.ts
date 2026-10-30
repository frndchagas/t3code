// @effect-diagnostics nodeBuiltinImport:off -- Exercise the native lookup's subprocess transport without a desktop session.
import type * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import { expect, it, vi } from "vite-plus/test";

const execFileMock = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: ReadonlyArray<string>,
      options: NodeChildProcess.ExecFileOptions,
      callback: (error: NodeChildProcess.ExecFileException | null, stdout: string) => void,
    ) => NodeChildProcess.ChildProcess
  >(),
);
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { activeWindow } from "./ActiveWindow.ts";

const { execFile, ChildProcess: NativeChildProcess } =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");

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
      id: 42,
      title: "Editor",
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      owner: { name: "Editor", processId: 123, path: "/Applications/Editor.app", bundleId: "com.example.editor" }
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
