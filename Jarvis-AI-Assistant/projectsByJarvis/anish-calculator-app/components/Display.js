// File: components/Display.js

class Display {
  constructor(expressionDisplay, resultDisplay) {
    this.expressionDisplay = expressionDisplay;
    this.resultDisplay = resultDisplay;
    this.currentExpression = "";
    this.currentResult = "0";
    this.memory = 0;
    this.updateDisplay();
  }

  // Updates the display with the current expression and result
  updateDisplay() {
    this.expressionDisplay.textContent = this.currentExpression;
    this.resultDisplay.textContent = this.currentResult;
  }

  // Appends a digit to the current result
  appendDigit(digit) {
    if (this.currentResult === "0" && digit !== ".") {
      this.currentResult = digit;
    } else if (this.currentResult.includes(".") && digit === ".") {
      return; // Prevent multiple decimal points
    } else {
      this.currentResult += digit;
    }
    this.updateDisplay();
  }

  // Clears the display
  clear() {
    this.currentExpression = "";
    this.currentResult = "0";
    this.updateDisplay();
  }

  // Deletes the last digit from the current result
  backspace() {
    this.currentResult = this.currentResult.slice(0, -1);
    if (this.currentResult === "") {
      this.currentResult = "0";
    }
    this.updateDisplay();
  }

  // Performs an operation
  operate(operator) {
    if (this.currentResult === "") return;

    if (this.currentExpression !== "") {
      this.calculate();
    }

    this.currentExpression = this.currentResult + operator;
    this.currentResult = "0";
    this.updateDisplay();
  }

  // Toggles the positive/negative sign of the current result
  toggleSign() {
    this.currentResult = (parseFloat(this.currentResult) * -1).toString();
    this.updateDisplay();
  }

  // Calculates the result of the current expression
  calculate() {
    try {
      const expression = this.currentExpression + this.currentResult;
      const result = eval(expression); // Using eval with caution
      if (isNaN(result) || !isFinite(result)) {
        throw new Error("Invalid Operation");
      }
      this.currentResult = result.toString();
      this.currentExpression = "";
      this.updateDisplay();
    } catch (error) {
      this.currentResult = "Error";
      this.updateDisplay();
    }
  }

  // Memory functions
  memoryAdd() {
    this.memory += parseFloat(this.currentResult);
  }

  memorySubtract() {
    this.memory -= parseFloat(this.currentResult);
  }

  memoryRecall() {
    this.currentResult = this.memory.toString();
    this.updateDisplay();
  }

  memoryClear() {
    this.memory = 0;
  }
}

export default Display;