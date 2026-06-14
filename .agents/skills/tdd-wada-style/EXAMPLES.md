# TDD Examples - 具体的なテストパターン例

## Example 1: 計算ロジックのTDD

### 要件
税込価格を計算する関数を実装する。

### Step 1: テストリスト作成

```markdown
□ A 100 yen item returns 110 yen with a 10% tax rate.
□ A 0 yen item returns 0 yen.
□ Fractional amounts are truncated.
□ Negative prices raise an exception.
```

### Step 2: 最初のテスト（RED）

```python
# tests/unit/test_tax_calculator.py
def test_100_yen_item_returns_110_yen_with_10_percent_tax():
    # Arrange
    price = 100
    tax_rate = 0.10

    # Act
    result = calculate_tax_included_price(price, tax_rate)

    # Assert
    assert result == 110
```

テスト実行 → 失敗（関数が存在しない）

### Step 3: 最小実装（GREEN）

```python
# src/tax_calculator.py
def calculate_tax_included_price(price: int, tax_rate: float) -> int:
    return 110  # Fake implementation
```

テスト実行 → 成功

### Step 4: 次のテストを追加

```python
def test_zero_yen_returns_zero_yen():
    result = calculate_tax_included_price(0, 0.10)
    assert result == 0
```

テスト実行 → 失敗（110を返してしまう）

### Step 5: 一般化（GREEN）

```python
def calculate_tax_included_price(price: int, tax_rate: float) -> int:
    return int(price * (1 + tax_rate))
```

### Step 6: 境界値テスト追加

```python
def test_fractional_amount_is_truncated():
    # 99 * 1.10 = 108.9 -> 108
    result = calculate_tax_included_price(99, 0.10)
    assert result == 108

def test_negative_price_raises_value_error():
    with pytest.raises(ValueError) as exc_info:
        calculate_tax_included_price(-100, 0.10)
    assert "price must be greater than or equal to 0" in str(exc_info.value)
```

### 最終実装

```python
def calculate_tax_included_price(price: int, tax_rate: float) -> int:
    """Calculate tax-included price by truncating fractional amounts."""
    if price < 0:
        raise ValueError("price must be greater than or equal to 0")
    return int(price * (1 + tax_rate))
```

---

## Example 2: クラスのTDD

### 要件
カウンターを実装する。

### テストリスト

```markdown
□ Initial value is 0.
□ increment increases the value by 1.
□ decrement decreases the value by 1.
□ Value cannot go below 0 and decrement raises an exception.
□ reset returns the value to 0.
```

### テストコード

```python
class TestCounter:
    """Behavior tests for Counter."""

    def test_initial_value_is_zero(self):
        counter = Counter()
        assert counter.value == 0

    def test_increment_increases_value_by_one(self):
        # Arrange
        counter = Counter()

        # Act
        counter.increment()

        # Assert
        assert counter.value == 1

    def test_multiple_increments_increase_value_correctly(self):
        counter = Counter()
        counter.increment()
        counter.increment()
        counter.increment()
        assert counter.value == 3

    def test_decrement_decreases_value_by_one(self):
        counter = Counter()
        counter.increment()
        counter.increment()

        counter.decrement()

        assert counter.value == 1

    def test_decrement_from_zero_raises_value_error(self):
        counter = Counter()
        with pytest.raises(ValueError) as exc_info:
            counter.decrement()
        assert "value cannot be less than zero" in str(exc_info.value)

    def test_reset_returns_value_to_zero(self):
        counter = Counter()
        counter.increment()
        counter.increment()

        counter.reset()

        assert counter.value == 0
```

### 実装

```python
class Counter:
    """Simple counter."""

    def __init__(self):
        self._value = 0

    @property
    def value(self) -> int:
        return self._value

    def increment(self) -> None:
        self._value += 1

    def decrement(self) -> None:
        if self._value <= 0:
            raise ValueError("value cannot be less than zero")
        self._value -= 1

    def reset(self) -> None:
        self._value = 0
```

---

## Example 3: 外部依存のあるコードのTDD

### 要件
天気APIから気温を取得し、服装を提案する。

### テストリスト

```markdown
□ 25 degrees or higher suggests "t-shirt".
□ 15 to 24 degrees suggests "long sleeves".
□ Below 15 degrees suggests "coat".
□ API failure returns "weather data unavailable".
```

### テストコード（モック使用）

```python
from unittest.mock import Mock, patch

class TestClothingAdvisor:
    """Behavior tests for ClothingAdvisor."""

    def test_temperature_at_or_above_25_suggests_t_shirt(self):
        # Arrange
        mock_api = Mock()
        mock_api.get_temperature.return_value = 28
        advisor = ClothingAdvisor(weather_api=mock_api)

        # Act
        result = advisor.suggest()

        # Assert
        assert result == "t-shirt"

    def test_temperature_between_15_and_24_suggests_long_sleeves(self):
        mock_api = Mock()
        mock_api.get_temperature.return_value = 20
        advisor = ClothingAdvisor(weather_api=mock_api)

        result = advisor.suggest()

        assert result == "long sleeves"

    def test_temperature_below_15_suggests_coat(self):
        mock_api = Mock()
        mock_api.get_temperature.return_value = 10
        advisor = ClothingAdvisor(weather_api=mock_api)

        result = advisor.suggest()

        assert result == "coat"

    def test_api_failure_returns_unavailable_message(self):
        mock_api = Mock()
        mock_api.get_temperature.side_effect = ConnectionError("API error")
        advisor = ClothingAdvisor(weather_api=mock_api)

        result = advisor.suggest()

        assert result == "weather data unavailable"

    # Boundary value tests
    def test_exactly_25_degrees_suggests_t_shirt(self):
        mock_api = Mock()
        mock_api.get_temperature.return_value = 25
        advisor = ClothingAdvisor(weather_api=mock_api)

        assert advisor.suggest() == "t-shirt"

    def test_exactly_15_degrees_suggests_long_sleeves(self):
        mock_api = Mock()
        mock_api.get_temperature.return_value = 15
        advisor = ClothingAdvisor(weather_api=mock_api)

        assert advisor.suggest() == "long sleeves"
```

### 実装

```python
class ClothingAdvisor:
    """Suggest clothing based on weather data."""

    def __init__(self, weather_api):
        self._api = weather_api

    def suggest(self) -> str:
        try:
            temp = self._api.get_temperature()
        except Exception:
            return "weather data unavailable"

        if temp >= 25:
            return "t-shirt"
        elif temp >= 15:
            return "long sleeves"
        else:
            return "coat"
```

---

## ポイントまとめ

1. **最小のテストから始める** - 最も単純なケースを最初に
2. **仮実装でもOK** - まずはハードコードでグリーンに
3. **三角測量** - 複数のテストで実装を一般化
4. **境界値を忘れない** - ちょうど25度、ちょうど15度など
5. **外部依存はモック** - APIやDBはテストダブルを使用
