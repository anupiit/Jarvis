```javascript
// File: components/Button.js
// Purpose: JavaScript file for creating reusable button components.

class Button extends HTMLElement {
  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() {
    return ['value', 'type'];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'value' || name === 'type') {
      this.render();
    }
  }

  connectedCallback() {
    this.render();
  }

  render() {
    const value = this.getAttribute('value') || '';
    const type = this.getAttribute('type') || 'number';

    this.shadow.innerHTML = `
      <style>
        button {
          width: 100%;
          height: 100%;
          font-size: 1.5em;
          border: none;
          background-color: #f0f0f0;
          cursor: pointer;
          transition: background-color 0.3s ease;
          border-radius: 5px;
        }

        button:hover {
          background-color: #e0e0e0;
        }

        button:active {
          background-color: #d0d0d0;
        }

        .operator {
          background-color: #f5a623;
          color: white;
        }

        .operator:hover {
          background-color: #e6911a;
        }

        .operator:active {
          background-color: #d77d11;
        }

        .clear {
          background-color: #d9534f;
          color: white;
        }

        .clear:hover {
          background-color: #c9302c;
        }

        .clear:active {
          background-color: #b81d1d;
        }
      </style>
      <button class="${type}">${value}</button>
    `;
  }
}

customElements.define('calculator-button', Button);


// File: script.js
// Purpose: Main JavaScript file for the calculator application.

document.addEventListener('DOMContentLoaded', () => {
  const resultDisplay = document.getElementById('result');
  const expressionDisplay = document.getElementById('expression');
  const buttons = document.querySelectorAll('calculator-button button');

  let currentExpression = '';
  let currentResult = '0';
  let memory = 0;

  updateDisplay();

  function updateDisplay() {
    resultDisplay.textContent = currentResult;
    expressionDisplay.textContent = currentExpression;
  }

  function handleNumberInput(number) {
    if (currentResult === '0' || currentResult === 'Error') {
      currentResult = number;
    } else {
      currentResult += number;
    }
    updateDisplay();
  }

  function handleOperatorInput(operator) {
    if (currentResult !== 'Error') {
      currentExpression += currentResult + operator;
      currentResult = '0';
      updateDisplay();
    }
  }

  function handleDecimalInput() {
    if (!currentResult.includes('.')) {
      currentResult += '.';
      updateDisplay();
    }
  }

  function handleClearInput() {
    currentExpression = '';
    currentResult = '0';
    updateDisplay();
  }

  function handleBackspaceInput() {
    currentResult = currentResult.slice(0, -1);
    if (currentResult === '') {
      currentResult = '0';
    }
    updateDisplay();
  }

  function handleEqualsInput() {
    if (currentResult !== 'Error') {
      try {
        currentExpression += currentResult;
        // eslint-disable-next-line no-eval
        let result = eval(currentExpression);

        if (!isFinite(result)) {
          throw new Error("Division by zero");
        }
        currentResult = String(result);
        currentExpression = '';
      } catch (error) {
        console.error(error);
        currentResult = 'Error';
        currentExpression = '';
      } finally {
        updateDisplay();
      }
    }
  }

  function handleMemoryAdd() {
    if (currentResult !== 'Error') {
      memory += parseFloat(currentResult);
    }
  }

  function handleMemorySubtract() {
    if (currentResult !== 'Error') {
      memory -= parseFloat(currentResult);
    }
  }

  function handleMemoryRecall() {
    currentResult = String(memory);
    updateDisplay();
  }

  function handleMemoryClear() {
    memory = 0;
  }

  function handlePositiveNegativeToggle() {
    if (currentResult !== '0' && currentResult !== 'Error') {
      currentResult = String(parseFloat(currentResult) * -1);
      updateDisplay();
    }
  }

  buttons.forEach(button => {
    button.addEventListener('click', () => {
      const value = button.textContent;

      switch (value) {
        case '0':
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9':
          handleNumberInput(value);
          break;
        case '+':
        case '-':
        case '*':
        case '/':
          handleOperatorInput(value);
          break;
        case '.':
          handleDecimalInput();
          break;
        case 'AC':
          handleClearInput();
          break;
        case '←':
          handleBackspaceInput();
          break;
        case '=':
          handleEqualsInput();
          break;
        case 'M+':
          handleMemoryAdd();
          break;
        case 'M-':
          handleMemorySubtract();
          break;
        case 'MR':
          handleMemoryRecall();
          break;
        case 'MC':
          handleMemoryClear();
          break;
        case '+/-':
          handlePositiveNegativeToggle();
          break;
        default:
          break;
      }
    });
  });

  // Keyboard support
  document.addEventListener('keydown', (event) => {
    const key = event.key;

    if (!isNaN(parseInt(key)) || key === '.') {
      handleNumberInput(key);
    } else if (['+', '-', '*', '/'].includes(key)) {
      handleOperatorInput(key);
    } else if (key === 'Enter') {
      handleEqualsInput();
    } else if (key === 'Backspace') {
      handleBackspaceInput();
    } else if (key.toLowerCase() === 'c') {
      handleClearInput();
    }
  });
});

// File: index.html
// Purpose: HTML file for the calculator web application.

<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Calculator</title>
  <link rel="stylesheet" href="style.css">
  <script src="components/Button.js"></script>
  <script src="script.js"></script>
</head>
<body>
  <div class="calculator">
    <div class="display">
      <div id="expression"></div>
      <div id="result">0</div>
    </div>
    <div class="buttons">
      <calculator-button value="AC" type="clear"></calculator-button>
      <calculator-button value="←"></calculator-button>
      <calculator-button value="+/-"></calculator-button>
      <calculator-button value="/" type="operator"></calculator-button>

      <calculator-button value="7"></calculator-button>
      <calculator-button value="8"></calculator-button>
      <calculator-button value="9"></calculator-button>
      <calculator-button value="*" type="operator"></calculator-button>

      <calculator-button value="4"></calculator-button>
      <calculator-button value="5"></calculator-button>
      <calculator-button value="6"></calculator-button>
      <calculator-button value="-" type="operator"></calculator-button>

      <calculator-button value="1"></calculator-button>
      <calculator-button value="2"></calculator-button>
      <calculator-button value="3"></calculator-button>
      <calculator-button value="+" type="operator"></calculator-button>

      <calculator-button value="0"></calculator-button>
      <calculator-button value="."></calculator-button>
      <calculator-button value="=" type="operator"></calculator-