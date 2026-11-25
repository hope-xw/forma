import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  if (process.env.FORMA_FORCE_ADHOC_SIGN === "1") {
    // Builder treats a cached ZIP as a custom distribution and leaves this bootstrap app.
    rmSync(path.join(appPath, "Contents/Resources/default_app.asar"), {
      force: true,
    });
  } else {
    try {
      execFileSync(
        "/usr/bin/codesign",
        ["--verify", "--deep", "--strict", appPath],
        {
          stdio: "ignore",
        },
      );
      const details = spawnSync("/usr/bin/codesign", ["-dvv", appPath], {
        encoding: "utf8",
      });
      if (
        details.status === 0 &&
        /^Identifier=com\.forma\.design$/m.test(details.stderr) &&
        /^(Signature=adhoc|Authority=Developer ID Application: .+)$/m.test(
          details.stderr,
        )
      )
        return;
    } catch {
      // Signature missing or invalidated after modifying Info.plist / asar / icon.
    }
  }

  console.log(`  • ad-hoc signing macOS bundle  file=${appPath}`);
  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--deep", "--sign", "-", appPath],
    {
      stdio: "inherit",
    },
  );
  execFileSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", appPath],
    {
      stdio: "inherit",
    },
  );
}
