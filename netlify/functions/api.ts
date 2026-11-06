// Private backend. All routes are under /api/*.
import type { Config } from "@netlify/functions";
import { createApp } from "../../server/app";

const app = createApp();
export default async (req: Request) => app(req);
export const config: Config = { path: "/api/*" };
