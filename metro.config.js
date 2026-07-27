const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("node:path");

const config = getDefaultConfig(__dirname);

// etl/ is a standalone Python project. Metro never resolves .py, but its file watcher
// still crawls the whole tree and etl/.venv holds tens of thousands of files.
const etlDir = path.resolve(__dirname, "etl").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
config.resolver.blockList = [
  ...[].concat(config.resolver.blockList ?? []),
  new RegExp(`^${etlDir}\\${path.sep}.*$`),
];

module.exports = withNativeWind(config, { input: "./src/global.css" });
