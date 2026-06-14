---
name: tdd-wada-style
description: t.wada流TDD（テスト駆動開発）。新機能実装、バグ修正、リファクタリング時に自動適用。Red-Green-Refactorサイクル、AAA構造、振る舞いテストの原則に従う。コード、テスト名、コメント、docstring、エラーメッセージ例は英語で書く。テストを書く、テストファーストで実装する、テストコードをレビューする際に使用。
---

# t.wada流 TDD（テスト駆動開発）

和田卓人氏のTDD哲学に基づき、高品質なテスト駆動開発を実践する。

## Core Philosophy（中核思想）

> 「テストとは、動くことを証明するものではない。間違いを見つけるためのものだ。」
> — t.wada

### 3つの原則

1. **テストは設計行為** — テストを書くことで、使いやすいAPIを設計する
2. **テストは仕様書** — テストコードが最も正確なドキュメントである
3. **小さく回す** — Red → Green → Refactor を短いサイクルで繰り返す

## TDD Cycle（Red-Green-Refactor）

```
RED        -> Write a failing test first.
     ↓
GREEN      -> Make the test pass with the smallest implementation.
     ↓
REFACTOR   -> Improve the design while all tests stay green.
     ↓
   Repeat.
```

## Instructions

### Step 1: 要件を振る舞いで分解

実装前に「〜したとき、〜となる」形式でテストケースをリストアップする。

```markdown
Test case list:
□ Empty list returns an empty list.
□ Single-element list returns the same list.
□ Multiple elements are sorted in ascending order.
□ Negative numbers are sorted correctly.
```

最も単純なケースから始める。

### Step 2: テスト構造（AAA パターン）

すべてのテストは Arrange-Act-Assert の3フェーズで構成する。

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

### Step 3: 境界値と異常系

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

### Step 4: Refactor（リファクタリング）

テストがグリーンの状態を維持しながら:
- 重複の除去
- 命名の改善
- 責務の分離

**ルール:** 振る舞いを変えずに構造を改善する

## Anti-Patterns（避けるべきパターン）

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

- [ ] すべてのテストがパス
- [ ] 各テストが独立して実行可能
- [ ] テスト名から振る舞いが理解できる
- [ ] コード、識別子、コメント、docstring、ログ、エラーメッセージ例が英語で書かれている
- [ ] AAA構造が明確
- [ ] 境界値がカバーされている
- [ ] 異常系がカバーされている
- [ ] 実装詳細ではなく振る舞いをテスト
- [ ] 過度なモックを使用していない

## References

追加のガイダンスは以下を参照:
- [EXAMPLES.md](EXAMPLES.md) - 具体的なテストパターン例
- [PATTERNS.md](PATTERNS.md) - よくあるテストパターン集
