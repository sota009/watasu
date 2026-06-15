---
name: tdd-wada-style
description: t.wada流TDD（テスト駆動開発）。新機能実装、バグ修正、リファクタリング時に自動適用。Kent BeckのCanonical TDDに基づく List-Red-Green-Refactor、AAA構造、振る舞いテストの原則に従う。コード、テスト名、コメント、docstring、エラーメッセージ例は英語で書く。テストを書く、テストファーストで実装する、テストコードをレビューする際に使用。
---

# t.wada流 TDD（テスト駆動開発）

和田卓人氏のTDD哲学に基づき、高品質なテスト駆動開発を実践する。

## Core Philosophy（中核思想）

TDDは「先にテストを書くこと」だけではなく、振る舞い変更を安全に進めるための小さなワークフローである。

### 4つの原則

1. **テストリストから始める** — 期待する振る舞いを分析し、実装設計を混ぜすぎずに候補を並べる
2. **テストはインターフェイス設計** — テストを書くことで、使いやすいAPIや境界を設計する
3. **ひとつずつ具体化する** — テストリストから1項目だけ選び、失敗を確認してから実装する
4. **小さく回す** — List → Red → Green → Refactor を短いサイクルで繰り返す

## Canonical TDD Cycle（List-Red-Green-Refactor）

```
LIST       -> List behavior scenarios before writing test code.
     ↓
RED        -> Translate one list item into one failing automated test.
     ↓
GREEN      -> Make the test pass with the smallest implementation.
     ↓
REFACTOR   -> Improve the design while all tests stay green.
     ↓
   Repeat.
```

## Instructions

### Step 1: テストリストを作る

実装前に「〜したとき、〜となる」形式で振る舞い候補をリストアップする。これは具体的なテストコードではなく、分析メモである。

```markdown
Test case list:
□ Empty list returns an empty list.
□ Single-element list returns the same list.
□ Multiple elements are sorted in ascending order.
□ Negative numbers are sorted correctly.
```

ルール:
- 実装の設計判断を混ぜすぎない。呼び出し方や観測可能な結果を中心に書く。
- 既存の振る舞いを壊さないための回帰ケースも入れる。
- 最初に全項目をテストコード化しない。次に進めるのは1項目だけ。
- 実装中に新しい不安やケースを見つけたら、いまの作業へ割り込ませずテストリストに追加する。

最も単純で、失敗理由が明確になりやすいケースから始める。

### Step 2: ひとつだけテストを書く（AAA パターン）

テストリストから1項目だけ選び、Arrange-Act-Assert の3フェーズを持つ、実行可能で失敗する自動テストへ翻訳する。必要なら Assert から逆向きに書き始める。

```python
def test_describes_behavior_in_english():
    # Arrange
    sut = TargetClass()
    input_data = create_test_data()

    # Act
    result = sut.target_method(input_data)

    # Assert
    assert result == expected_value
```

**ポイント:**
- テスト名は英語で振る舞いを明確に記述
- コード、識別子、コメント、docstring、ログ、エラーメッセージ例はすべて英語で書く
- 1テスト1アサーション（原則）
- 3つのブロックを空行で明確に分離
- アサーションのないテスト、スナップショットだけのテスト、カバレッジ稼ぎのテストを書かない
- 期待値は実装結果のコピーではなく、仕様・例・独立した計算から決める

### Step 3: Green（最小実装）

失敗するテストを確認してから、いま書いたテストと既存テストを通す最小の実装を行う。

ルール:
- アサーション削除、期待値の都合よい変更、skip化でGreenにしない。
- Green中にリファクタリングを混ぜない。まず動かし、それから整える。
- 新しいケースに気づいたらテストリストに追記する。
- テストが通ったら対応するリスト項目に完了印をつける。

### Step 4: Refactor（必要なときだけ）

テストがグリーンの状態を維持しながら、実装の設計を改善する。

対象:
- 重複の除去
- 命名の改善
- 責務の分離
- テストの読みやすさ改善

ルール:
- 振る舞いを変えずに構造を改善する。
- 重複はヒントであって命令ではない。早すぎる抽象化を避ける。
- 次のテストに進む不安を隠すための過剰な整理をしない。

### Step 5: テストリストが空になるまで繰り返す

次のリスト項目をひとつ選び、Red → Green → Refactor を繰り返す。コードの動作への不安が退屈に変わるところを終了の目安にする。

## Coverage Guidance（境界値と異常系）

必ず以下をカバーする:

```python
# Boundary value tests
def test_empty_input_returns_empty_list():
    assert func([]) == []

def test_single_element_returns_same_list():
    assert func([1]) == [1]

def test_max_value_is_accepted():
    assert func([MAX_VALUE]) == expected

def test_max_value_plus_one_raises_value_error():
    with pytest.raises(ValueError):
        func([MAX_VALUE + 1])

# Error case tests
def test_none_input_raises_type_error():
    with pytest.raises(TypeError):
        func(None)

def test_invalid_type_raises_type_error():
    with pytest.raises(TypeError):
        func("not a list")
```

## Anti-Patterns（避けるべきパターン）

### ❌ TDDを単なる自動テストやテストファーストと混同する

```markdown
Bad:
□ Write all tests first.
□ Make them pass later.
□ Skip refactoring because tests exist.

Good:
□ Keep a behavior test list.
□ Turn one item into one failing test.
□ Make it pass.
□ Refactor when useful.
□ Repeat.
```

TDDは自動テスト、開発者テスト、テストファーストを含み得るが、それらだけではTDDではない。

### ❌ 実装詳細のテスト

```python
# Bad: Depends on internal state.
assert obj._internal_cache == {...}
assert obj._call_count == 3

# Good: Tests observable behavior.
assert obj.get_result() == expected
```

### ❌ テスト間の依存

```python
# Bad: Depends on state from a previous test.
class TestCounter:
    counter = Counter()  # Shared state

    def test_1(self):
        self.counter.increment()

    def test_2(self):
        assert self.counter.value == 1  # Depends on test_1

# Good: Each test is independent.
def test_increment_increases_value_by_one():
    counter = Counter()
    counter.increment()
    assert counter.value == 1
```

### ❌ 過度なモック

```python
# Bad: Mocks everything and tests nothing meaningful.
@patch('module.ClassA')
@patch('module.ClassB')
@patch('module.ClassC')
def test_something(mock_a, mock_b, mock_c):
    ...

# Good: Mocks only the external boundary.
@patch('module.external_api_client')
def test_something(mock_api):
    ...
```

### ❌ 巨大なテスト

```python
# Bad: Covers multiple behaviors in one test.
def test_user_registration():
    # 50 lines of test code...
    assert user.email == ...
    assert user.created_at == ...
    assert email_sent == True
    assert db.users.count() == ...

# Good: One behavior per test.
def test_user_registration_saves_email_address():
    ...

def test_user_registration_sends_confirmation_email():
    ...
```

### ❌ Greenの偽装

```python
# Bad: Copies the implementation output into the expected value.
result = calculate_invoice(input_data)
assert result == result

# Bad: Removes the meaningful assertion to pass the test.
calculate_invoice(input_data)

# Good: Uses an independently derived expected value.
result = calculate_invoice(input_data)
assert result.total == Decimal("120.00")
```

## Test Template

新しいテストファイルを作成する際のテンプレート:

```python
"""
Tests for {module_name}.

Subject under test: {class_name/function_name}
"""
import pytest
from src.module import TargetClass


class Test{TargetClass}:
    """Behavior tests for TargetClass."""

    # ========== Happy paths ==========

    def test_common_use_case_returns_expected_value(self):
        """The most common use case."""
        # Arrange
        sut = TargetClass()

        # Act
        result = sut.do_something("input")

        # Assert
        assert result == "expected"

    # ========== Boundary values ==========

    def test_empty_input_returns_empty_string(self):
        """Handles empty input."""
        sut = TargetClass()
        result = sut.do_something("")
        assert result == ""

    def test_max_length_input_is_accepted(self):
        """Handles maximum length input."""
        sut = TargetClass()
        result = sut.do_something("x" * MAX_LENGTH)
        assert len(result) <= MAX_LENGTH

    # ========== Error cases ==========

    def test_none_input_raises_type_error(self):
        """Raises TypeError when None is passed."""
        sut = TargetClass()
        with pytest.raises(TypeError):
            sut.do_something(None)

    def test_invalid_input_raises_value_error(self):
        """Raises ValueError for invalid input."""
        sut = TargetClass()
        with pytest.raises(ValueError) as exc_info:
            sut.do_something("invalid")
        assert "invalid input" in str(exc_info.value)
```

## Checklist

実装完了時の確認項目:

- [ ] テストリストを作り、1項目ずつRed化した
- [ ] 最初に全テストを具体化していない
- [ ] 各Redが期待した理由で失敗することを確認した
- [ ] Green中にアサーション削除、skip化、期待値弱体化、過剰リファクタをしていない
- [ ] すべてのテストがパス
- [ ] 各テストが独立して実行可能
- [ ] テスト名から振る舞いが理解できる
- [ ] コード、識別子、コメント、docstring、ログ、エラーメッセージ例が英語で書かれている
- [ ] AAA構造が明確
- [ ] 境界値がカバーされている
- [ ] 異常系がカバーされている
- [ ] 実装詳細ではなく振る舞いをテスト
- [ ] 過度なモックを使用していない
- [ ] 重複除去や抽象化を「必要な分だけ」に留めた

## References

追加のガイダンスは以下を参照:
- [Canonical TDD by Kent Beck, translated by t-wada](https://t-wada.hatenablog.jp/entry/canon-tdd-by-kent-beck) - List-Red-Green-Refactor の原典に近い定義
- [EXAMPLES.md](EXAMPLES.md) - 具体的なテストパターン例
- [PATTERNS.md](PATTERNS.md) - よくあるテストパターン集
