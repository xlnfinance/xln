import { shared } from "@here.build/eslint-configs";
import { arrivalOverlay } from "../../eslint.arrival.mjs";

export default [...shared, ...arrivalOverlay({ tsconfigRootDir: import.meta.dirname })];
