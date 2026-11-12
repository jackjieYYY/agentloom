当前处于初期开发阶段,不需要任何向下兼容，不需要任何迁移代码。允许breaking change.
除非有明确的特别指令，否则不得擅自修改 `package.json`、`tsconfig.json`、`vitest.config.ts`、`README.md` 等项目配置文件。
禁止过度的门禁测试,门禁测试只需要覆盖核心功能。
单元测试仅保留核心代码的验证；以完整 `src/**/*.ts` 为统计范围，整体覆盖率不得超过 30%，不要求单个核心文件低于 30%。
除非有明确的特别指令，否则不得擅自修改 `package.json` 里面的scripts,lib
