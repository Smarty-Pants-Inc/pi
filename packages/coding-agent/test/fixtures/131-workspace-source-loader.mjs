import { registerHooks } from "node:module";
const root = new URL("../../../../", import.meta.url);
const exact = {
  "@earendil-works/pi-ai":"packages/ai/src/index.ts",
  "@earendil-works/pi-ai/compat":"packages/ai/src/compat.ts",
  "@earendil-works/pi-ai/oauth":"packages/ai/src/oauth.ts",
  "@earendil-works/pi-agent-core":"packages/agent/src/index.ts",
  "@earendil-works/pi-tui":"packages/tui/src/index.ts",
  "@earendil-works/pi-coding-agent":"packages/coding-agent/src/index.ts",
  "@earendil-works/pi-mcp":"packages/mcp/src/index.ts",
  "@earendil-works/pi-mcp/oauth":"packages/mcp/src/oauth/index.ts",
  "@earendil-works/pi-codemode":"packages/codemode/src/index.ts",
  "@earendil-works/pi-codemode/declarations":"packages/codemode/src/declarations.ts",
  "@earendil-works/pi-codemode/source":"packages/codemode/src/source.ts",
  "@earendil-works/chord":"packages/chord/src/index.ts",
  "@earendil-works/chord/context":"packages/chord/src/context/index.ts",
  "@earendil-works/chord/delta":"packages/chord/src/delta/index.ts",
  "@earendil-works/chord/bundler":"packages/chord/src/bundler.ts",
  "@earendil-works/chord/node":"packages/chord/src/node.ts",
  "@earendil-works/pi-telemetry":"packages/telemetry/src/index.ts",
  "@earendil-works/pi-telemetry/testing":"packages/telemetry/src/testing/index.ts",
  "@earendil-works/pi-protocol":"packages/protocol/src/index.ts",
  "@earendil-works/pi-client":"packages/client/src/index.ts",
  "@earendil-works/pi-server":"packages/server/src/index.ts"
};
registerHooks({resolve(specifier,context,nextResolve){
  let path=exact[specifier];
  for(const sub of ["providers","api","utils"]){
    const prefix="@earendil-works/pi-ai/"+sub+"/";
    if(specifier.startsWith(prefix))path="packages/ai/src/"+sub+"/"+specifier.slice(prefix.length)+".ts";
  }
  return nextResolve(path?new URL(path,root).href:specifier,context);
}});
