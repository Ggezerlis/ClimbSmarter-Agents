import { Router, type IRouter } from "express";
import { startCompanyAgents } from "../lib/companyAgents";
import healthRouter from "./health";
import authRouter from "./auth";
import trainingRouter from "./training";
import progressRouter from "./progress";
import subscriptionRouter from "./subscription";
import nutritionRouter from "./nutrition";
import workoutRouter from "./workout";
import settingsRouter from "./settings";
import stripeRouter from "./stripe";
import revenuecatRouter from "./revenuecat";
import coachRouter from "./coach";
import shareRouter from "./share";
import adminRouter from "./admin";

const router: IRouter = Router();

// Boot the autonomous agent fleet (Argus, Metis, Calliope, Atlas, Chief).
// Idempotent, fully internal — none of these agents can take outward actions.
startCompanyAgents();

router.use(healthRouter);
router.use(authRouter);
router.use(trainingRouter);
router.use(progressRouter);
router.use(subscriptionRouter);
router.use(nutritionRouter);
router.use(workoutRouter);
router.use(settingsRouter);
router.use(stripeRouter);
router.use(revenuecatRouter);
router.use(coachRouter);
router.use(shareRouter);
router.use(adminRouter);

export default router;
