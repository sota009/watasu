# TDD Patterns - よくあるテストパターン集

## Fixture Patterns（準備パターン）

### Setup/Teardown

```python
import pytest

class TestDatabase:
    @pytest.fixture(autouse=True)
    def setup(self):
        """Run before each test."""
        self.db = create_test_database()
        yield
        # Run after each test for cleanup.
        self.db.cleanup()

    def test_insert(self):
        self.db.insert({"id": 1})
        assert self.db.count() == 1
```

### Shared Fixture

```python
@pytest.fixture
def sample_user():
    """Create a test user."""
    return User(
        email="test@example.com",
        name="Test User",
        age=25
    )

def test_user_name_can_be_read(sample_user):
    assert sample_user.name == "Test User"

def test_user_is_adult(sample_user):
    assert sample_user.is_adult() == True
```

### Factory Fixture

```python
@pytest.fixture
def create_user():
    """Create users for tests."""
    def _create(name="Test", age=20, **kwargs):
        return User(name=name, age=age, **kwargs)
    return _create

def test_minor_is_not_adult(create_user):
    user = create_user(age=17)
    assert user.is_adult() == False

def test_adult_is_adult(create_user):
    user = create_user(age=20)
    assert user.is_adult() == True
```

---

## Assertion Patterns（検証パターン）

### 複数条件の検証

```python
# Bad: Later assertions are hidden when the first one fails.
def test_user_creation():
    user = create_user()
    assert user.id is not None
    assert user.created_at is not None
    assert user.status == "active"

# Good: Uses pytest-check to report all assertion failures.
from pytest_check import check

def test_user_creation():
    user = create_user()
    with check:
        assert user.id is not None
    with check:
        assert user.created_at is not None
    with check:
        assert user.status == "active"
```

### カスタムマッチャー

```python
def assert_valid_email(email: str):
    """Assert that the email address format is valid."""
    import re
    pattern = r'^[\w\.-]+@[\w\.-]+\.\w+$'
    assert re.match(pattern, email), f"invalid email format: {email}"

def test_user_registration_sets_email_address():
    user = register_user("test@example.com")
    assert_valid_email(user.email)
```

### 近似値の検証

```python
import pytest

def test_floating_point_calculation():
    result = calculate_pi()
    assert result == pytest.approx(3.14159, rel=1e-5)

def test_list_values_are_approximately_equal():
    result = normalize_vector([3, 4])
    assert result == pytest.approx([0.6, 0.8])
```

---

## Exception Patterns（例外パターン）

### 例外の型を検証

```python
def test_division_by_zero_raises_zero_division_error():
    with pytest.raises(ZeroDivisionError):
        divide(10, 0)
```

### 例外メッセージを検証

```python
def test_invalid_age_raises_value_error():
    with pytest.raises(ValueError) as exc_info:
        validate_age(-1)
    assert "age must be greater than or equal to 0" in str(exc_info.value)
```

### 例外が発生しないことを検証

```python
def test_valid_input_does_not_raise_exception():
    # Passes if no exception is raised.
    result = process_data(valid_input)
    assert result is not None
```

---

## Mock Patterns（モックパターン）

### 戻り値のモック

```python
from unittest.mock import Mock

def test_api_success_returns_success():
    mock_client = Mock()
    mock_client.fetch.return_value = {"status": "ok"}

    service = MyService(client=mock_client)
    result = service.process()

    assert result == "success"
```

### 例外のモック

```python
def test_api_failure_returns_error():
    mock_client = Mock()
    mock_client.fetch.side_effect = ConnectionError("timeout")

    service = MyService(client=mock_client)
    result = service.process()

    assert result == "error"
```

### 呼び出しの検証

```python
def test_api_is_called_with_expected_arguments():
    mock_client = Mock()
    service = MyService(client=mock_client)

    service.fetch_user(user_id=123)

    mock_client.fetch.assert_called_once_with(
        endpoint="/users/123",
        method="GET"
    )
```

### パッチデコレータ

```python
from unittest.mock import patch

@patch('mymodule.external_api')
def test_external_api_call_is_processed(mock_api):
    mock_api.return_value = {"data": "test"}

    result = my_function()

    assert result == "processed: test"
```

---

## Parameterized Tests（パラメータ化テスト）

### 複数入力パターン

```python
import pytest

@pytest.mark.parametrize("input,expected", [
    (0, "zero"),
    (1, "one"),
    (2, "two"),
    (-1, "negative"),
])
def test_number_to_word(input, expected):
    assert number_to_word(input) == expected
```

### 境界値テスト

```python
@pytest.mark.parametrize("age,is_adult", [
    (17, False),   # Boundary value - 1
    (18, True),    # Boundary value
    (19, True),    # Boundary value + 1
    (0, False),    # Minimum value
    (120, True),   # Maximum value
])
def test_adult_check(age, is_adult):
    assert check_adult(age) == is_adult
```

### ID付きパラメータ

```python
@pytest.mark.parametrize("email,valid", [
    pytest.param("test@example.com", True, id="valid-email"),
    pytest.param("invalid", False, id="missing-at-sign"),
    pytest.param("@example.com", False, id="missing-local-part"),
    pytest.param("test@", False, id="missing-domain"),
])
def test_email_validation(email, valid):
    assert validate_email(email) == valid
```

---

## Async Test Patterns（非同期テスト）

### pytest-asyncio

```python
import pytest

@pytest.mark.asyncio
async def test_async_data_fetch():
    result = await fetch_data_async()
    assert result is not None

@pytest.mark.asyncio
async def test_async_timeout_raises_timeout_error():
    with pytest.raises(TimeoutError):
        await fetch_with_timeout(timeout=0.001)
```

---

## Test Organization（テスト構成）

### クラスによるグループ化

```python
class TestUserRegistration:
    """Behavior tests for user registration."""

    class TestHappyPaths:
        def test_valid_data_registers_user(self):
            ...

        def test_registration_sends_confirmation_email(self):
            ...

    class TestErrorCases:
        def test_duplicate_email_fails(self):
            ...

        def test_invalid_email_format_fails(self):
            ...

    class TestBoundaryValues:
        def test_name_at_max_length_is_accepted(self):
            ...

        def test_name_over_max_length_fails(self):
            ...
```

### マーカーによる分類

```python
import pytest

@pytest.mark.slow
def test_large_data_processing():
    """Long-running test."""
    ...

@pytest.mark.integration
def test_database_connection():
    """Integration test."""
    ...

# Run with: pytest -m "not slow"
```

---

## チェックリスト

テスト作成時の確認項目:

- [ ] テスト名が振る舞いを説明している
- [ ] AAA構造が明確
- [ ] 1テスト1アサーション（原則）
- [ ] 境界値をカバー
- [ ] 異常系をカバー
- [ ] 外部依存は適切にモック
- [ ] テスト間の依存がない
- [ ] 実行が高速（100ms以内が理想）
