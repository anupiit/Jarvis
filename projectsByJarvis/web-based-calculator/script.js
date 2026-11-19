(function() {
    'use strict';

    // DOM Elements
    const display = document.getElementById('display');
    const btnClear = document.getElementById('clear');
    const btnEquals = document.getElementById('equals');
    const btnDecimal = document.getElementById('decimal');
    
    const operatorButtons = {
        add: document.getElementById('add'),
        subtract: document.getElementById('subtract'),
        multiply: document.getElementById('multiply'),
        divide: document.getElementById('divide')
    };

    const numberButtons = {};
    for (let i = 0; i <= 9; i++) {
        numberButtons[i] = document.getElementById(`n${i}`);
    }

    // Guard against missing essential elements
    if (!display) return;

    // Calculator State
    let state = {
        currentValue: '0',
        previousValue: null,
        operator: null,
        waitingForOperand: false
    };

    /**
     * Load state from localStorage with safety guards
     */
    function loadPersistedState() {
        try {
            const saved = localStorage.getItem('calculator_state');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed && typeof parsed === 'object') {
                    state = { ...state, ...parsed };
                }
            }
        } catch (error) {
            console.error('Failed to parse calculator state:', error);
            // Fallback to default state already defined
        }
    }

    /**
     * Save state to localStorage
     */
    function persistState() {
        try {
            localStorage.setItem('calculator_state', JSON.stringify(state));
        } catch (error) {
            console.warn('Failed to save calculator state:', error);
        }
    }

    /**
     * Update the UI display based on current state
     */
    function updateDisplay() {
        // Handle error strings or overflow
        if (state.currentValue === 'Error') {
            display.textContent = 'Error';
        } else {
            // Trim display if it's too long for the UI
            const displayVal = state.currentValue.toString();
            display.textContent = displayVal.length > 12 
                ? parseFloat(displayVal).toExponential(5) 
                : displayVal;
        }
        persistState();
    }

    /**
     * Perform the actual mathematical operation
     */
    function calculate(first, second, operator) {
        const a = parseFloat(first);
        const b = parseFloat(second);

        if (isNaN(a) || isNaN(b)) return second;

        switch (operator) {
            case 'add': return a + b;
            case 'subtract': return a - b;
            case 'multiply': return a * b;
            case 'divide': return b === 0 ? 'Error' : a / b;
            default: return b;
        }
    }

    /**
     * Logic for handling number inputs
     */
    function inputDigit(digit) {
        const { currentValue, waitingForOperand } = state;

        if (waitingForOperand) {
            state.currentValue = String(digit);
            state.waitingForOperand = false;
        } else {
            state.currentValue = currentValue === '0' ? String(digit) : currentValue + digit;
        }
        updateDisplay();
    }

    /**
     * Logic for handling decimal point
     */
    function inputDecimal() {
        if (state.waitingForOperand) {
            state.currentValue = '0.';
            state.waitingForOperand = false;
            updateDisplay();
            return;
        }

        if (!state.currentValue.includes('.')) {
            state.currentValue += '.';
            updateDisplay();
        }
    }

    /**
     * Logic for handling operator buttons
     */
    function handleOperator(nextOperator) {
        const { currentValue, previousValue, operator } = state;
        const inputValue = parseFloat(currentValue);

        if (operator && state.waitingForOperand) {
            state.operator = nextOperator;
            return;
        }

        if (previousValue === null && !isNaN(inputValue)) {
            state.previousValue = inputValue;
        } else if (operator) {
            const result = calculate(previousValue, inputValue, operator);
            state.currentValue = String(result);
            state.previousValue = result === 'Error' ? null : result;
        }

        state.waitingForOperand = true;
        state.operator = nextOperator;
        updateDisplay();
    }

    /**
     * Logic for the equals button
     */
    function handleEquals() {
        const { currentValue, previousValue, operator } = state;

        if (!operator || state.waitingForOperand) return;

        const result = calculate(previousValue, currentValue, operator);
        state.currentValue = String(result);
        state.previousValue = null;
        state.operator = null;
        state.waitingForOperand = false;
        updateDisplay();
    }

    /**
     * Resets the calculator
     */
    function clearAll() {
        state = {
            currentValue: '0',
            previousValue: null,
            operator: null,
            waitingForOperand: false
        };
        updateDisplay();
    }

    // Event Listeners Initialization
    function init() {
        // Load persistent state if available
        loadPersistedState();
        updateDisplay();

        // Clear button
        if (btnClear) btnClear.addEventListener('click', clearAll);

        // Equals button
        if (btnEquals) btnEquals.addEventListener('click', handleEquals);

        // Decimal button
        if (btnDecimal) btnDecimal.addEventListener('click', inputDecimal);

        // Number buttons 0-9
        Object.keys(numberButtons).forEach(key => {
            const btn = numberButtons[key];
            if (btn) {
                btn.addEventListener('click', () => inputDigit(key));
            }
        });

        // Operator buttons
        Object.keys(operatorButtons).forEach(key => {
            const btn = operatorButtons[key];
            if (btn) {
                btn.addEventListener('click', () => handleOperator(key));
            }
        });

        // Keyboard Support
        document.addEventListener('keydown', (event) => {
            const { key } = event;
            if (/\d/.test(key)) inputDigit(key);
            if (key === '.') inputDecimal();
            if (key === '=' || key === 'Enter') handleEquals();
            if (key === 'Escape') clearAll();
            if (key === '+') handleOperator('add');
            if (key === '-') handleOperator('subtract');
            if (key === '*') handleOperator('multiply');
            if (key === '/') {
                event.preventDefault();
                handleOperator('divide');
            }
        });
    }

    // Run initialization
    init();

})();
