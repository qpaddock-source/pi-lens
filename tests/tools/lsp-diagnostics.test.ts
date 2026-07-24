import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
	service: null as unknown,
}));

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () => mocked.service,
}));

import { createLspDiagnosticsTool } from "../../tools/lsp-diagnostics.js";

async function executeFileDiagnostics() {
	const tool = createLspDiagnosticsTool();
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-health-"));
	const filePath = path.join(tmpDir, "example.ts");
	fs.writeFileSync(filePath, "const value = 1;\n");

	try {
		return await tool.execute(
			"diag-file",
			{ filePath, severity: "all" },
			new AbortController().signal,
			null,
			{ cwd: "." },
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

describe("lsp_diagnostics tool", () => {
	beforeEach(() => {
		mocked.service = {
			openFile: vi.fn().mockResolvedValue(undefined),
			getDiagnostics: vi.fn().mockImplementation(async (filePath: string) => {
				if (filePath.endsWith("bad.ts")) {
					return [
						{
							severity: 1,
							message: "Type 'string' is not assignable to type 'number'.",
							range: {
								start: { line: 0, character: 16 },
								end: { line: 0, character: 24 },
							},
							source: "ts",
						},
					];
				}
				return [];
			}),
			getDiagnosticsHealth: vi.fn().mockReturnValue(undefined),
		};
	});

	it("checks explicit filePaths as a batch", async () => {
		const tool = createLspDiagnosticsTool();
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-diag-"));
		const good = path.join(tmpDir, "good.ts");
		const bad = path.join(tmpDir, "bad.ts");
		fs.writeFileSync(good, "const value = 1;\n");
		fs.writeFileSync(bad, "const value: number = 'oops';\n");

		try {
			const result = (await tool.execute(
				"diag-batch",
				{ filePaths: [good, bad], severity: "all", concurrency: 2 },
				new AbortController().signal,
				null,
				{ cwd: "." },
			)) as any;

			expect(result.isError).toBeUndefined();
			expect(result.details?.mode).toBe("batch");
			expect(result.details?.filesChecked).toBe(2);
			expect(result.details?.totalDiagnostics).toBe(1);
			expect(String(result.content[0]?.text)).toContain("Files checked: 2");
			expect(String(result.content[0]?.text)).toContain("not assignable");
			expect(
				(mocked.service as { openFile: ReturnType<typeof vi.fn> }).openFile,
			).toHaveBeenCalledTimes(2);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("reports LSP unavailable when no clients are ready", async () => {
		(
			mocked.service as {
				getDiagnostics: ReturnType<typeof vi.fn>;
				getDiagnosticsHealth: ReturnType<typeof vi.fn>;
			}
		).getDiagnostics.mockResolvedValue([]);
		(
			mocked.service as {
				getDiagnosticsHealth: ReturnType<typeof vi.fn>;
			}
		).getDiagnosticsHealth.mockReturnValue({
			health: "no_clients",
			failureKind: "no_clients",
			serverCountAttempted: 1,
			serverCountReady: 0,
			candidateServerIds: ["typescript"],
			mergedCount: 0,
			dedupDroppedCount: 0,
			checkedAt: new Date().toISOString(),
		});

		const result = (await executeFileDiagnostics()) as any;
		const content = String(result.content[0]?.text);

		expect(content).toContain("LSP unavailable");
		expect(content).not.toContain("No diagnostics found.");
		expect(result.details?.lspHealth).toMatchObject({
			health: "no_clients",
			serverCountAttempted: 1,
			serverCountReady: 0,
		});
	});

	it("labels last-known diagnostics as stale when no clients are ready", async () => {
		(
			mocked.service as {
				getDiagnostics: ReturnType<typeof vi.fn>;
				getDiagnosticsHealth: ReturnType<typeof vi.fn>;
			}
		).getDiagnostics.mockResolvedValue([
			{
				severity: 1,
				message: "stale type error",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 5 },
				},
				source: "ts",
			},
		]);
		(
			mocked.service as {
				getDiagnosticsHealth: ReturnType<typeof vi.fn>;
			}
		).getDiagnosticsHealth.mockReturnValue({
			health: "no_clients_stale",
			failureKind: "no_clients_stale",
			serverCountAttempted: 1,
			serverCountReady: 0,
			candidateServerIds: ["typescript"],
			mergedCount: 1,
			dedupDroppedCount: 0,
			checkedAt: new Date().toISOString(),
		});

		const result = (await executeFileDiagnostics()) as any;
		const content = String(result.content[0]?.text);

		expect(content).toContain("LSP unavailable");
		expect(content).toContain("stale last-known diagnostics");
		expect(content).toContain("stale type error");
		expect(result.details?.lspHealth.health).toBe("no_clients_stale");
	});

	it("keeps a healthy empty result distinct from LSP unavailability", async () => {
		(
			mocked.service as {
				getDiagnostics: ReturnType<typeof vi.fn>;
				getDiagnosticsHealth: ReturnType<typeof vi.fn>;
			}
		).getDiagnostics.mockResolvedValue([]);
		(
			mocked.service as {
				getDiagnosticsHealth: ReturnType<typeof vi.fn>;
			}
		).getDiagnosticsHealth.mockReturnValue({
			health: "ok_empty",
			failureKind: "none",
			serverCountAttempted: 1,
			serverCountReady: 1,
			candidateServerIds: ["typescript"],
			mergedCount: 0,
			dedupDroppedCount: 0,
			checkedAt: new Date().toISOString(),
		});

		const result = (await executeFileDiagnostics()) as any;
		const content = String(result.content[0]?.text);

		expect(content).toBe("No diagnostics found.");
		expect(content).not.toContain("LSP unavailable");
		expect(result.details?.lspHealth).toMatchObject({
			health: "ok_empty",
			serverCountAttempted: 1,
			serverCountReady: 1,
		});
	});

	it("requires either filePath or filePaths", async () => {
		const tool = createLspDiagnosticsTool();
		const result = (await tool.execute(
			"diag-missing",
			{},
			new AbortController().signal,
			null,
			{ cwd: "." },
		)) as any;

		expect(result.isError).toBe(true);
		expect(String(result.content[0]?.text)).toContain(
			"filePath or filePaths is required",
		);
	});
});
