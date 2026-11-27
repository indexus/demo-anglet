import { GatewaySession } from "js-indexus-sdk";

const origin = process.env.INDEXUS_API_GATEWAY || "https://demo.indexus.io";
const session = new GatewaySession({ origin, contentRecords: true });
const network = await session.network();
const collection = "DvFMV2020idx0001";
const root = await network.getSets(collection, ["@"], { raw: true });
if (root.unresolved.length) throw new Error("Could not read the DVF root");
const records = await network.getContentRecords(collection, "@", 100);
console.log(`${records.length} DVF records returned by ${origin} (limit 100)`);
