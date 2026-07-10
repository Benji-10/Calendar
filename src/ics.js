/* single implementation lives in the functions lib (CJS) so the
   email pipeline and the app parse feeds identically */
export { parseICS } from "../netlify/functions/lib/ics-parse.cjs";
