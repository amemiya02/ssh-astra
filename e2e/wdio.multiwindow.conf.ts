// A fresh sandbox for the Linux two-Window smoke test and optional RSS samples.
import { config as smokeConfig } from "./wdio.conf.ts";

export const config: WebdriverIO.Config = {
  ...smokeConfig,
  specs: ["./multiwindow/*.e2e.ts"],
};
