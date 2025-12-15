import { Config } from "@remotion/cli/config";

// Video rendering settings
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);

// Concurrency settings for Lambda rendering
// Note: framesPerLambda and concurrencyPerLambda are set in the renderMediaOnLambda call
// These CLI settings are for local development
Config.setConcurrency(1); // Match Lambda concurrency setting
