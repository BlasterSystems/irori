// refract end-of-turn check: runs the project's test command after each agent run.
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
const TEST_COMMAND = "pnpm test";
export default function (pi: HookAPI) {
	pi.on("agent_end", async (_event, ctx) => {
		const { code } = await pi.exec("sh", ["-c", TEST_COMMAND], { cwd: ctx.cwd, timeout: 120_000 });
		if (code !== 0 && ctx.hasUI) ctx.ui.notify(`refract: test command failed: ${TEST_COMMAND}`, "warning");
	});
}
