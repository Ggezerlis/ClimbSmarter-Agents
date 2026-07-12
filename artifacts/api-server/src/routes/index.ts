import { Router, type IRouter } from "express";
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
