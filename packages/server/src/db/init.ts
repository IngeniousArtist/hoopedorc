import { initDb } from "./index";
import { ENV } from "../config";

const db = initDb();
console.log(`[db] initialized schema at ${ENV.dbPath}`);
db.close();
