/// <reference types="@cloudflare/workers-types" />

export {};

declare global {
  interface CloudflareEnv {
    API_GATEWAY: Fetcher;
  }
}
