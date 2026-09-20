// ESLint 配置 —— 宽松取向：只拦截常规语法错误与明显可疑模式，不做代码风格约束。
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 生成物与临时目录不检查（node_modules 由 ESLint 默认忽略）
  { ignores: ['output/**', '.tmp/**', 'dist/**'] },
  // recommended：只含"正确性"规则，无风格类规则
  ...tseslint.configs.recommended,
  {
    rules: {
      // 力学/几何代码中局部显式 any 偶尔是最短表达，不作强制
      '@typescript-eslint/no-explicit-any': 'off',
      // 未使用变量报错；_ 前缀视为有意占位
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
