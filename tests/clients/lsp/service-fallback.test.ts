import { beforeEach, describe, expect, it, vi } from "vitest";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

vi.mock("../../../clients/lsp/config.js", () => ({
	getServersForFileWithConfig,
}));
vi.mock("../../../clients/lsp/client.js", () => ({
	createLSPClient,
}));

const FILE = "/repo/example.py";

function fakeClient() {
	return {
		isAlive: () => true,
		shutdown: vi.fn(async () => {}),
		getWorkspaceDiagnosticsSupport: () => ({
			advertised: false,
			mode: "push-only" as const,
			diagnosticProviderKind: "none" as const,
		}),
		getOperationSupport: () => ({}),
	};
}

function server(
	id: string,
	options: { fallbackFor?: string; available?: boolean } = {},
) {
	return {
		id,
		name: id,
		extensions: [".py"],
		fallbackFor: options.fallbackFor,
		root: vi.fn(async () => "/repo"),
		spawn: vi.fn(async () =>
			options.available === false
				? undefined
				: {
						process: {
							process: { killed: false },
							stdin: {},
							stdout: {},
							stderr: {},
							pid: 1234,
						},
					},
		),
	};
}

beforeEach(() => {
	getServersForFileWithConfig.mockReset();
	createLSPClient.mockReset();
	createLSPClient.mockImplementation(async () => fakeClient());
});

describe("LSP service fallback selection", () => {
	it("skips a declared fallback when its primary server is ready", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const primary = server("python");
		const jedi = server("python-jedi", { fallbackFor: "python" });
		getServersForFileWithConfig.mockReturnValue([primary, jedi]);

		const result = await new LSPService().getClientsForFile(FILE);

		expect(primary.spawn).toHaveBeenCalledTimes(1);
		expect(jedi.spawn).not.toHaveBeenCalled();
		expect(result.clients.map((entry) => entry.info.id)).toEqual(["python"]);
		expect(result.serverCountAttempted).toBe(1);
	});

	it("starts a declared fallback when its primary server is unavailable", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const primary = server("python", { available: false });
		const jedi = server("python-jedi", { fallbackFor: "python" });
		getServersForFileWithConfig.mockReturnValue([primary, jedi]);

		const result = await new LSPService().getClientsForFile(FILE);

		expect(primary.spawn).toHaveBeenCalledTimes(1);
		expect(jedi.spawn).toHaveBeenCalledTimes(1);
		expect(result.clients.map((entry) => entry.info.id)).toEqual([
			"python-jedi",
		]);
		expect(result.serverCountAttempted).toBe(2);
	});

	it("keeps complementary servers while skipping a satisfied fallback", async () => {
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const primary = server("python");
		const complementary = server("python-analysis");
		const jedi = server("python-jedi", { fallbackFor: "python" });
		getServersForFileWithConfig.mockReturnValue([
			primary,
			complementary,
			jedi,
		]);

		const result = await new LSPService().getClientsForFile(FILE);

		expect(complementary.spawn).toHaveBeenCalledTimes(1);
		expect(jedi.spawn).not.toHaveBeenCalled();
		expect(result.clients.map((entry) => entry.info.id).sort()).toEqual([
			"python",
			"python-analysis",
		]);
		expect(result.serverCountAttempted).toBe(2);
	});
});
