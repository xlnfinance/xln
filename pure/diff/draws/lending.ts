// Lending draws. Owner: the "lending" area thread.
import { pending, type Moves } from "./areas.ts";

export const LENDING: Moves<"lending"> = {
  lendingOffer: pending("a hub lending book"),
  lendingBorrow: pending("a lending offer"),
  lendingRepay: pending("an active loan"),
  lendingClosePosition: pending("an idle lending position"),
};
