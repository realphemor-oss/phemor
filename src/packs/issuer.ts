/**
 * 发行方公钥（只能验证激活码，不能签发，可以公开）。
 * 由 `npm run license -- init` 生成并写入这个文件，之后重新构建、发布网页即可。
 * 还没生成时是 null：网页会提示「此版本尚未启用授权」，加密单词包无法安装，明文包不受影响。
 */
export const ISSUER_PUBLIC_KEY: JsonWebKey | null = null;
