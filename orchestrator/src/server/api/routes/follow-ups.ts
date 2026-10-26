import { toAppError } from "@infra/errors";
import { fail, ok } from "@infra/http";
import { listFollowups } from "@server/services/followup-service";
import { type Request, type Response, Router } from "express";

export const followUpsRouter = Router();

followUpsRouter.get("/", async (_req: Request, res: Response) => {
  try {
    ok(res, await listFollowups(Math.floor(Date.now() / 1000)));
  } catch (error) {
    fail(res, toAppError(error));
  }
});
