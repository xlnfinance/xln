<script lang="ts">
  export let label: string;
  export let id: string;
  export let type: 'text' | 'number' | 'select' | 'range' = 'text';
  export let value: any = '';
  export let placeholder = '';
  export let min: number | undefined = undefined;
  export let max: number | undefined = undefined;
  export let step: number | undefined = undefined;
  export let options: Array<{value: any, label: string}> = [];
  export let helpText = '';
  export let required = false;
  export let disabled = false;

  function handleInput(event: Event) {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (type === 'number' || type === 'range') {
      value = parseFloat(target.value) || 0;
    } else {
      value = target.value;
    }
  }
</script>

<div class="form-field">
  <label for={id} class="form-label">
    {label}
    {#if required}<span class="required">*</span>{/if}
  </label>
  
  {#if type === 'select'}
    <select {id} {disabled} bind:value on:change={handleInput} class="form-input">
      {#each options as option}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  {:else if type === 'range'}
    <input 
      {id} 
      type="range" 
      {min} 
      {max} 
      {step}
      {disabled}
      bind:value 
      on:input={handleInput}
      class="form-range"
    />
  {:else}
    <input 
      {id} 
      {type} 
      {placeholder} 
      {min} 
      {max} 
      {step}
      {disabled}
      bind:value 
      on:input={handleInput}
      class="form-input"
    />
  {/if}
  
  {#if helpText}
    <small class="help-text">{helpText}</small>
  {/if}
</div>

<style>
  .form-field {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
  }

  .form-label {
    font-weight: 600;
    color: #d4d4d4;
    font-size: 14px;
  }

  .required {
    color: #dc3545;
    margin-left: 4px;
  }

  .form-input {
    padding: 10px 12px;
    border: 2px solid #555;
    border-radius: 6px;
    font-size: 14px;
    background: #1e1e1e;
    color: #d4d4d4;
    transition: border-color 0.3s ease;
  }

  .form-input:focus {
    outline: none;
    border-color: #007acc;
  }

  .form-input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .form-range {
    width: 100%;
    height: 6px;
    border-radius: 3px;
    background: #555;
    outline: none;
    -webkit-appearance: none;
    appearance: none;
  }

  .form-range::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #007acc;
    cursor: pointer;
  }

  .form-range::-moz-range-thumb {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #007acc;
    cursor: pointer;
    border: none;
  }

  .help-text {
    color: #9d9d9d;
    font-size: 12px;
    margin-top: 4px;
  }
</style>
