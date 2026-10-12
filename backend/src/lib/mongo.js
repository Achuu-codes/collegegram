/**
 * MongoDB connection lifecycle.
 *
 * Decisions worth defending:
 *
 * 1. Fail fast on boot. The original server logged a connection error and kept
 *    listening, which means the process would accept traffic and return 500s
 *    forever. A process that cannot reach its database is not healthy; it should
 *    exit so the supervisor (nodemon, systemd, ECS, Render) restarts or alerts.
 *    Note this applies to the *initial* connect only — see point 2.
 *
 * 2. Tolerate a blip after boot. Once connected, mongoose buffers and retries
 *    internally on a transient network drop. Exiting on every blip would turn a
 *    two-second network hiccup into a cold restart, so we log and let the driver
 *    recover. The health endpoint reports the degraded state in the meantime.
 *
 * 3. Explicit pool size. The default `maxPoolSize` is 100 connections *per
 *    process*. That matters when you scale horizontally: 20 app instances x 100
 *    = 2000 connections, which will exhaust the server's connection limit long
 *    before CPU becomes the bottleneck. We set it deliberately and document it.
 *
 * 4. `strictQuery: true` makes mongoose throw on query fields absent from the
 *    schema instead of silently ignoring them. A typo'd filter key that is
 *    silently dropped turns `find({ autorId: x })` into `find({})` — returning
 *    every document in the collection instead of none. That is both a
 *    correctness bug and a data-exposure bug, and it is very hard to spot.
 */
import mongoose from "mongoose";
import config from "../config/index.js";
import logger from "./logger.js";

mongoose.set("strictQuery", true);

// Surfaces slow/unexpected queries during development without a profiler.
if (!config.isProduction && !config.isTest) {
  mongoose.set("debug", (collection, method, query) => {
    logger.debug({ collection, method, query }, "mongo query");
  });
}

export async function connectMongo(uri = config.mongo.uri) {
  mongoose.connection.on("disconnected", () => logger.warn("mongo disconnected"));
  mongoose.connection.on("reconnected", () => logger.info("mongo reconnected"));
  mongoose.connection.on("error", (err) => logger.error({ err }, "mongo connection error"));

  await mongoose.connect(uri, {
    /**
     * Mongoose's default is to create every declared index on startup. That is
     * convenient in development and dangerous in production: an index build on
     * a large collection consumes CPU and I/O on the primary, and it is
     * triggered implicitly by a deploy, at an unpredictable moment, with no
     * operator watching. Production indexes should be created deliberately and
     * observed. Hence: on in dev and test, off in production.
     */
    autoIndex: !config.isProduction,
    maxPoolSize: 20,
    minPoolSize: 2,
    // Fail a request fast when no server is reachable rather than hanging for
    // the 30s default — a hung request holds a socket and a worker slot.
    serverSelectionTimeoutMS: 5_000,
    socketTimeoutMS: 45_000,
  });

  logger.info({ db: mongoose.connection.name }, "mongo connected");
  return mongoose.connection;
}

export async function disconnectMongo() {
  await mongoose.connection.close(false); // false = finish in-flight operations
  logger.info("mongo connection closed");
}

/** 1 = connected. Used by /health to report dependency state. */
export const isMongoHealthy = () => mongoose.connection.readyState === 1;

/**
 * An actual round trip, not just socket state. readyState can report "connected"
 * while the server is unresponsive, so the readiness probe pings.
 */
export async function pingMongo() {
  await mongoose.connection.db.admin().ping();
  return true;
}

export { mongoose };
