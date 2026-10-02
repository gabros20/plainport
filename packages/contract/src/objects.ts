// Object strictness (run decision D16). What plainport prints is output: its published JSON Schema stays open, so a
// field added later is not a breaking change for a reader that validates against an older schema. What plainport
// parses (arguments, config, files it owns) is input and stays strict, so a typo is an error rather than ignored.

import { z } from "zod";

export const outputObject = <S extends z.core.$ZodLooseShape>(shape: S) => z.looseObject(shape);
export const inputObject = <S extends z.core.$ZodLooseShape>(shape: S) => z.strictObject(shape);
