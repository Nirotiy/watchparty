export const apps = [
  {
    name: "server",
    script: "./server/main.ts",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    interpreter: "node",
    env: {
      PORT: 8080,
    },
  },
];
