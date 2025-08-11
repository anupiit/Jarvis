document.addEventListener('DOMContentLoaded', () => {
  // DOM elements
  const displayExpression = document.querySelector('.display-expression');
  const displayResult = document.querySelector('.display-result');
  const buttons = document.querySelector('.buttons');

  // Calculator state
  let expression = '';
  let result = '0';
  let memory = 0;

  // Constants
  const MAX_DISPLAY_LENGTH = 20; // Limit display length to prevent overflow

  // Utility functions

  // Update display
  const updateDisplay = () => {
    displayExpression.textContent = expression || '0';
    displayResult.textContent = result;
  };

  // Evaluate expression (using eval with caution and input sanitization)
  const evaluateExpression = () => {
    try {
      const sanitizedExpression = expression.replace(/[^-()\d/*+.]/g, ''); // Basic sanitization
      if (!sanitizedExpression) {
        return '0';
      }

      // More robust sanitization to prevent code injection
      if (/[^\d\s+\-*/().]/.test(sanitizedExpression)) {
        throw new Error("Invalid characters in expression");
      }

      // Check for consecutive operators
      if (/[\+\-\*/\.]{2,}/.test(sanitizedExpression)) {
        throw new Error("Invalid expression format");
      }

      // Check for unbalanced parentheses
      const openParens = (sanitizedExpression.match(/\(/g) || []).length;
      const closeParens = (sanitizedExpression.match(/\)/g) || []).length;
      if (openParens !== closeParens) {
        throw new Error("Unbalanced parentheses");
      }

      // Prevent leading zeros in numbers
      const leadingZeroRegex = /(^|\D)0+(\d)/g;
      const cleanedExpression = sanitizedExpression.replace(leadingZeroRegex, '$1$2');

      // Evaluate the sanitized expression
      let calculatedResult = eval(cleanedExpression);  // Eval is used here after VERY CAREFUL sanitization
      if (isNaN(calculatedResult) || !isFinite(calculatedResult)) {
        throw new Error("Invalid Calculation");
      }
      return String(calculatedResult);

    } catch (error) {
      console.error("Evaluation Error:", error);
      return 'Error';
    }
  };



  // Event handlers

  // Handle button clicks
  const handleButtonClick = (event) => {
    const buttonValue = event.target.textContent;
    const buttonType = event.target.dataset.type;

    switch (buttonType) {
      case 'number':
        if (result === '0' || result === 'Error') {
          result = buttonValue;
        } else if (result.length < MAX_DISPLAY_LENGTH) {
          result += buttonValue;
        }
        break;

      case 'operator':
        if (result !== 'Error') {
          expression = result;
          expression += buttonValue;
          result = '0';
        }
        break;

      case 'decimal':
        if (!result.includes('.') && result.length < MAX_DISPLAY_LENGTH) {
          result += '.';
        }
        break;

      case 'clear':
        expression = '';
        result = '0';
        break;

      case 'backspace':
        result = result.slice(0, -1) || '0';
        break;

      case 'equals':
        if (result !== 'Error') {
          expression += result;
          result = evaluateExpression();
        }
        break;

      case 'memory-add':
        if (result !== 'Error') {
          memory += parseFloat(result);
        }
        break;

      case 'memory-subtract':
        if (result !== 'Error') {
          memory -= parseFloat(result);
        }
        break;

      case 'memory-recall':
        result = String(memory);
        break;

      case 'memory-clear':
        memory = 0;
        break;

      case 'pos-neg':
        if (result !== '0' && result !== 'Error') {
          result = String(parseFloat(result) * -1);
        }
        break;
      default:
        console.warn('Unknown button type:', buttonType);
    }

    updateDisplay();
  };

  // Keyboard support
  const handleKeyboardInput = (event) => {
    const key = event.key;

    if (/[0-9]/.test(key)) {
      document.querySelector(`[data-type="number"][textContent="${key}"]`).click();
    } else if (['+', '-', '*', '/'].includes(key)) {
      document.querySelector(`[data-type="operator"][textContent="${key}"]`).click();
    } else if (key === '.') {
      document.querySelector('[data-type="decimal"]').click();
    } else if (key === 'Enter' || key === '=') {
      document.querySelector('[data-type="equals"]').click();
    } else if (key === 'Backspace') {
      document.querySelector('[data-type="backspace"]').click();
    } else if (key === 'Escape') {
      document.querySelector('[data-type="clear"]').click();
    }
  };

  // Event listeners
  buttons.addEventListener('click', handleButtonClick);
  window.addEventListener('keydown', handleKeyboardInput);

  // Initial display update
  updateDisplay();
});