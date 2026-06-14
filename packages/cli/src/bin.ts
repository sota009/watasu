#!/usr/bin/env node

import { corePackageName } from "@watasu/core";

console.log(JSON.stringify({ ok: true, command: "watasu", core: corePackageName }));

