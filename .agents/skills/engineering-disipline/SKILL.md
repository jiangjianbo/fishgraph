---
name: engineering-discipline
description: Apply fundamental software engineering principles during coding tasks. Use when writing, modifying, debugging, refactoring, reviewing, or testing code, scripts, configuration, or automation. Ensures clear responsibility boundaries, separation of concerns, intent-oriented main flows, proper encapsulation, reuse of existing capabilities, minimal complexity, correct logic ownership, and root-cause fixes instead of local patches.
---

# Engineering Discipline

本 Skill 用于在具体编码任务中落实项目的通用编程基本原则。`agents.md` 定义全局原则，本 Skill 负责在执行过程中主动检查这些原则是否被落实。

## 1. 编码前

在修改代码前快速确认：

- 当前任务的明确目标和成功标准是什么？
- 现有代码中是否已经存在相关能力？
- 本次修改涉及哪些职责？
- 新逻辑应该属于哪个模块？
- 是否存在更简单且符合现有结构的实现？

不要因为实现方便，将新逻辑直接放入当前正在修改的代码位置。

## 2. 实现时

始终保持以下结构：

- 主流程表达意图，具体实现由下层函数或模块承担。
- 一个函数、类或模块保持清晰的主要职责。
- 不同关注点保持分离。
- 复杂逻辑进行合理封装。
- 优先复用已有能力，不重复实现。
- 新逻辑放入职责真正所属的位置。
- 不为了当前任务引入不必要的抽象、框架或复杂度。
- 环境、配置和可变参数不要无理由硬编码。

尤其避免这种演化：

```text
简单需求
  ↓
增加一个判断
  ↓
再增加一个特殊处理
  ↓
再增加一个异常分支
  ↓
主流程逐渐承担所有职责
```

当实现开始依赖大量特殊判断或补丁时，暂停继续编码，重新检查职责划分和根因。

## 3. 修改时

采用最小必要修改，但“最小修改”不等于“把代码塞进最近的位置”。

修改前后检查：

```text
是否破坏职责边界？
是否产生重复逻辑？
是否引入新的隐式依赖？
是否改变不必要的依赖方向？
是否使主流程更加复杂？
是否把实现细节泄漏到调用方？
```

如果局部修复需要不断增加条件、分支或特殊处理，应优先重新审视设计。

## 4. 完成前自检

完成代码后进行一次快速工程检查：

- 主流程是否能够直接表达程序意图？
- 每段复杂逻辑是否位于正确的职责边界？
- 是否重复实现了已有能力？
- 是否存在职责混杂？
- 是否存在可以消除的特殊分支？
- 是否存在不必要的复杂抽象？
- 是否通过补丁掩盖了真正根因？
- 是否引入了无关修改？

功能正确但结构明显退化时，不应直接认为任务完成。

## 5. 与其他 Skill 的关系

本 Skill 是通用工程约束，不替代具体任务 Skill。

具体任务 Skill 负责：

```text
“这个任务应该怎么做”
```

本 Skill 负责：

```text
“无论做什么任务，都不能丢掉哪些工程基本功”
```

具体任务 Skill 与本 Skill 冲突时，以 `agents.md` 中的全局工程原则为准。