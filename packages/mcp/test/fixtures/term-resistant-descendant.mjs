process.on("SIGTERM", () => {});
process.send?.("ready");
setInterval(() => {}, 1000);
