import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { addAiHttpRoutes } from "./ai/http";
import { addOAuthHttpRoutes } from "./oauth/http";
import { addTrackingHttpRoutes } from "./tracking/http";

const http = httpRouter();

auth.addHttpRoutes(http);
addAiHttpRoutes(http);
addOAuthHttpRoutes(http);
addTrackingHttpRoutes(http);

export default http;
