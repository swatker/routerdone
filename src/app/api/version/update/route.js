import { NextResponse } from "next/server";
import { spawnUpdaterPrepare } from "@/lib/appUpdater";

export async function POST() {
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json(
      { success: false, message: "Update is only available in production build (routerdone CLI)" },
      { status: 403 }
    );
  }

  // Prepare/swap mode: spawn detached updater WITHOUT killing the app first.
  // The app keeps serving requests while the updater downloads the tarball.
  // The updater kills the old app at swap time, installs from the staged
  // tarball, and relaunches - minimising downtime to local install + relaunch.
  try {
    spawnUpdaterPrepare();
  } catch (e) {
    return NextResponse.json(
      { success: false, message: `Failed to start updater: ${e?.message || e}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    message: "Update started in background. App stays available during download.",
    statusPort: 20129,
  });
}
