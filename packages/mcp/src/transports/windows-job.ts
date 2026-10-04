import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import crossSpawn from "cross-spawn";

// A taskkill /T walk loses descendants when their original leader has already exited.
// The guardian joins a kill-on-close Job Object BEFORE starting the configured command.
// Windows then assigns every descendant to the job atomically. The guardian's parent
// watcher also closes custody when the host dies without calling transport.close().
const JOB_SOURCE = `
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class McpOwnedJob {
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max;
        public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Counters {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public Limits Basic; public Counters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, Total, Active, Terminated;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static int Run(string name, string marker, int parentPid, string command, string args, System.Collections.IDictionary environment) {
        IntPtr parent = OpenProcess(0x00100000, false, parentPid);
        if (parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        SetLastError(0);
        IntPtr job = CreateJobObject(IntPtr.Zero, name);
        int creationError = Marshal.GetLastWin32Error();
        if (job == IntPtr.Zero || creationError == 183) throw new Win32Exception(creationError);
        var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
        Check(AssignProcessToJobObject(job, GetCurrentProcess()));
        var watcher = new Thread(() => { WaitForSingleObject(parent, 0xffffffff); TerminateJobObject(job, 1); Environment.Exit(1); });
        watcher.IsBackground = true; watcher.Start();
        Console.Error.WriteLine(marker);
        var info = new ProcessStartInfo(command, args); info.UseShellExecute = false; info.CreateNoWindow = true;
        info.EnvironmentVariables.Clear();
        foreach (System.Collections.DictionaryEntry entry in environment) info.EnvironmentVariables[(string)entry.Key] = (string)entry.Value;
        using (var process = Process.Start(info)) {
            process.WaitForExit();
            int code = process.ExitCode;
            Check(TerminateJobObject(job, unchecked((uint)code)));
            return code;
        }
        // Explicit termination also handles a server opening its own job handle.
        // Kill-on-close remains the fallback if the guardian itself is killed.
    }
    public static void TerminateAndWait(string name) {
        IntPtr job = OpenJobObject(0x0004 | 0x0008, false, name);
        if (job == IntPtr.Zero) {
            int error = Marshal.GetLastWin32Error();
            if (error == 2) return; // Object is gone only after its last process exits.
            throw new Win32Exception(error);
        }
        try {
            Check(TerminateJobObject(job, 1));
            var deadline = Stopwatch.StartNew();
            while (true) {
                Accounting info;
                Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
                if (info.Active == 0) return;
                if (deadline.ElapsedMilliseconds >= 10000) throw new TimeoutException("MCP Windows job did not terminate");
                Thread.Sleep(10);
            }
        } finally { CloseHandle(job); }
    }
}`;

function psString(value: string): string {
	return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString("base64")}'))`;
}

function encodedCommand(statement: string): string[] {
	const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${JOB_SOURCE}\n'@\n${statement}`;
	return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

interface ParsedCommand {
	command: string;
	args: string[];
	options: SpawnOptions;
}

export interface WindowsJob {
	child: ChildProcess;
	ready: Promise<void>;
	close(): Promise<void>;
}

export function spawnWindowsJob(
	command: string,
	args: readonly string[],
	options: SpawnOptions,
	onStderr?: (chunk: Buffer) => void,
): WindowsJob {
	// This is cross-spawn's exported parser (pinned 7.0.6), including its .cmd shim
	// and shebang rules. Reusing it avoids replacing its shell escaping with ours.
	const parsed = (
		crossSpawn as typeof crossSpawn & {
			_parse(command: string, args: readonly string[], options: SpawnOptions): ParsedCommand;
		}
	)._parse(command, args, options);
	const argumentLine = parsed.options.windowsVerbatimArguments
		? parsed.args.join(" ")
		: parsed.args.map((arg) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`).join(" ");
	const id = randomUUID();
	const name = `Local\\pi-mcp-${id}`;
	const marker = `MCP_JOB_READY_${id}`;
	const environmentKey = `PI_MCP_JOB_ENV_${id.replaceAll("-", "")}`;
	const environment: Record<string, string> = Object.create(null);
	const seenKeys = new Set<string>();
	const suppliedEnvironment = options.env ?? process.env;
	// Match Node's Windows environment handling: the first lexically sorted case-insensitive key wins.
	for (const key of Object.keys(suppliedEnvironment).sort()) {
		const value = suppliedEnvironment[key];
		if (seenKeys.has(key.toUpperCase())) continue;
		seenKeys.add(key.toUpperCase());
		if (value !== undefined) environment[key] = value;
	}
	const powershell = join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	const child = spawn(
		powershell,
		encodedCommand(
			`$targetEnvironment = @{}\n(ConvertFrom-Json ([Environment]::GetEnvironmentVariable(${psString(environmentKey)}))).PSObject.Properties | ForEach-Object { $targetEnvironment[$_.Name] = [string]$_.Value }\nexit [McpOwnedJob]::Run(${psString(name)}, ${psString(marker)}, ${process.pid}, ${psString(parsed.command)}, ${psString(argumentLine)}, $targetEnvironment)`,
		),
		{
			...options,
			env: { ...environment, [environmentKey]: JSON.stringify(environment) },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: false,
		},
	);
	const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
	let startup = Buffer.alloc(0);
	let started = false;
	const ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("MCP Windows job guardian startup timed out"));
		}, 20000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (!started) reject(new Error(`MCP Windows job guardian exited (${code}): ${startup.toString("utf8")}`));
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (started) {
				onStderr?.(chunk);
				return;
			}
			if (startup.length + chunk.length > 64 * 1024) {
				clearTimeout(timer);
				child.kill();
				reject(new Error("MCP Windows job startup output exceeded limit"));
				return;
			}
			startup = Buffer.concat([startup, chunk]);
			const newline = startup.indexOf(0x0a);
			if (newline < 0) return;
			if (startup.subarray(0, newline).toString("utf8").trim() !== marker) return;
			started = true;
			clearTimeout(timer);
			const remainder = startup.subarray(newline + 1);
			startup = Buffer.alloc(0);
			if (remainder.length) onStderr?.(remainder);
			resolve();
		});
	});
	// The spawn error path may reject before StdioTransport has awaited readiness.
	void ready.catch(() => undefined);
	let closing: Promise<void> | undefined;
	return {
		child,
		ready,
		close() {
			closing ??= ready
				.catch(async () => {
					child.kill();
					await exited;
				})
				.then(
					() =>
						new Promise<void>((resolve, reject) => {
							const cleanup = spawn(
								powershell,
								encodedCommand(`[McpOwnedJob]::TerminateAndWait(${psString(name)})`),
								{
									...options,
									stdio: "ignore",
									windowsHide: true,
									detached: false,
								},
							);
							cleanup.once("error", reject);
							cleanup.once("close", (code) =>
								code === 0 ? resolve() : reject(new Error(`MCP Windows job cleanup failed (${code})`)),
							);
						}),
				);
			return closing;
		},
	};
}
