import type { UpdateRunResult } from "../../infra/update-runner.js";
import { formatCliCommand } from "../command-format.js";

type UnsafeUpdateRecovery = Extract<
  NonNullable<UpdateRunResult["recovery"]>,
  { serviceRestartSafe: false }
>;

export function resolveUnsafeUpdateRecoveryGuidance(
  reason: UnsafeUpdateRecovery["reason"],
): string {
  const updateCommand = formatCliCommand("openclaw update");
  if (reason === "rollback-checkout-dirty") {
    return `From the update root shown above, run \`git status --short\`, resolve the reported changes, then rerun \`${updateCommand}\`.`;
  }
  if (reason === "database-migration-uncertain") {
    return "A verified pre-migration backup was preserved. Keep the gateway stopped and rerun the candidate update or Doctor. For an explicit downgrade, stage the archive with `openclaw backup restore <archive> --target <fresh-directory>` and review every manifest mapping before activation.";
  }
  return `Review the failed recovery step above, repair the checkout or installation, then rerun \`${updateCommand}\`.`;
}
