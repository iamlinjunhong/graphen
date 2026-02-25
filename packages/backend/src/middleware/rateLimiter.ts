import rateLimit from "express-rate-limit";
import { appConfig } from "../config.js";

export const apiRateLimiter = rateLimit({
  windowMs: appConfig.RATE_LIMIT_WINDOW_MS,
  max: appConfig.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false
});
