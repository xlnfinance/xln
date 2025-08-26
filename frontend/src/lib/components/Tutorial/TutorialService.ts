/**
 * 🎯 TUTORIAL SERVICE
 * 
 * Manages tutorial state, progress, and integration with the UI
 */

import { writable, derived, get } from 'svelte/store';
import type { Tutorial, TutorialStep } from './TutorialSteps';
import { allTutorials, getTutorialById } from './TutorialSteps';

// Tutorial state stores
export const isActiveTutorial = writable(false);
export const currentTutorialId = writable<string | null>(null);
export const currentStepIndex = writable(0);
export const tutorialProgress = writable<Record<string, number>>({});

// Derived stores
export const currentTutorial = derived(
  currentTutorialId,
  ($currentTutorialId) => $currentTutorialId ? getTutorialById($currentTutorialId) : null
);

export const currentStep = derived(
  [currentTutorial, currentStepIndex],
  ([$currentTutorial, $currentStepIndex]) => 
    $currentTutorial?.steps[$currentStepIndex] || null
);

export const progressPercentage = derived(
  [currentTutorial, currentStepIndex],
  ([$currentTutorial, $currentStepIndex]) => 
    $currentTutorial ? (($currentStepIndex + 1) / $currentTutorial.steps.length) * 100 : 0
);

// Tutorial Service Class
class TutorialService {
  private highlightedElement: HTMLElement | null = null;

  // Start a tutorial
  startTutorial(tutorialId: string) {
    const tutorial = getTutorialById(tutorialId);
    if (!tutorial) {
      console.error(`Tutorial not found: ${tutorialId}`);
      return;
    }

    currentTutorialId.set(tutorialId);
    currentStepIndex.set(0);
    isActiveTutorial.set(true);
    
    console.log(`🎯 Starting tutorial: ${tutorial.title}`);
    this.applyCurrentStep();
  }

  // Navigate to next step
  nextStep() {
    const tutorial = get(currentTutorial);
    const stepIndex = get(currentStepIndex);
    
    if (!tutorial) return;

    if (stepIndex < tutorial.steps.length - 1) {
      currentStepIndex.update(n => n + 1);
      this.applyCurrentStep();
    } else {
      this.completeTutorial();
    }
  }

  // Navigate to previous step
  prevStep() {
    const stepIndex = get(currentStepIndex);
    if (stepIndex > 0) {
      currentStepIndex.update(n => n - 1);
      this.applyCurrentStep();
    }
  }

  // Execute current step action
  executeStepAction() {
    const step = get(currentStep);
    if (!step) return;

    const element = document.querySelector(step.target) as HTMLElement;
    if (!element) {
      console.warn(`🎯 Tutorial target not found: ${step.target}`);
      return;
    }

    switch (step.action) {
      case 'click':
        element.click();
        break;
      case 'fill':
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          element.value = step.value || '';
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }
        break;
      case 'select':
        if (element instanceof HTMLSelectElement) {
          element.value = step.value || '';
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
        break;
      case 'navigate':
        if (step.value) {
          window.location.href = step.value;
        }
        break;
    }

    // Auto-advance after action (with delay for visual feedback)
    setTimeout(() => this.nextStep(), 1500);
  }

  // Apply current step (highlighting, validation, etc.)
  private applyCurrentStep() {
    const step = get(currentStep);
    if (!step) return;

    this.clearHighlight();
    
    // Highlight target element
    if (step.target && step.action !== 'wait') {
      const element = document.querySelector(step.target) as HTMLElement;
      if (element) {
        this.highlightElement(element);
        // Scroll into view
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    // Save progress
    const tutorialId = get(currentTutorialId);
    const stepIndex = get(currentStepIndex);
    if (tutorialId) {
      tutorialProgress.update(progress => ({
        ...progress,
        [tutorialId]: stepIndex
      }));
      this.saveProgressToStorage();
    }
  }

  // Highlight an element
  private highlightElement(element: HTMLElement) {
    element.classList.add('tutorial-highlight');
    this.highlightedElement = element;
  }

  // Clear current highlight
  private clearHighlight() {
    if (this.highlightedElement) {
      this.highlightedElement.classList.remove('tutorial-highlight');
      this.highlightedElement = null;
    }
  }

  // Complete tutorial
  completeTutorial() {
    const tutorialId = get(currentTutorialId);
    console.log(`🎉 Tutorial completed: ${tutorialId}`);
    
    this.endTutorial();
    
    // Show completion message
    this.showCompletionMessage();
  }

  // End tutorial (cancel or complete)
  endTutorial() {
    isActiveTutorial.set(false);
    currentTutorialId.set(null);
    currentStepIndex.set(0);
    this.clearHighlight();
  }

  // Skip to step
  goToStep(stepIndex: number) {
    const tutorial = get(currentTutorial);
    if (!tutorial || stepIndex < 0 || stepIndex >= tutorial.steps.length) return;

    currentStepIndex.set(stepIndex);
    this.applyCurrentStep();
  }

  // Get tutorial progress
  getTutorialProgress(tutorialId: string): number {
    const progress = get(tutorialProgress);
    return progress[tutorialId] || 0;
  }

  // Check if tutorial is completed
  isTutorialCompleted(tutorialId: string): boolean {
    const tutorial = getTutorialById(tutorialId);
    if (!tutorial) return false;
    
    const progress = this.getTutorialProgress(tutorialId);
    return progress >= tutorial.steps.length - 1;
  }

  // Save progress to localStorage
  private saveProgressToStorage() {
    const progress = get(tutorialProgress);
    localStorage.setItem('xln-tutorial-progress', JSON.stringify(progress));
  }

  // Load progress from localStorage
  loadProgressFromStorage() {
    try {
      const saved = localStorage.getItem('xln-tutorial-progress');
      if (saved) {
        const progress = JSON.parse(saved);
        tutorialProgress.set(progress);
      }
    } catch (error) {
      console.warn('Failed to load tutorial progress:', error);
    }
  }

  // Show completion message
  private showCompletionMessage() {
    // You can implement this with a toast notification or modal
    console.log('🎉 Tutorial completed! Great job!');
    
    // Could dispatch a custom event for UI to handle
    window.dispatchEvent(new CustomEvent('tutorial-completed', {
      detail: { tutorialId: get(currentTutorialId) }
    }));
  }

  // Get available tutorials
  getAvailableTutorials(): Tutorial[] {
    return allTutorials;
  }

  // Get tutorials by difficulty
  getTutorialsByDifficulty(difficulty: 'beginner' | 'intermediate' | 'advanced'): Tutorial[] {
    return allTutorials.filter(tutorial => tutorial.difficulty === difficulty);
  }
}

// Export singleton instance
export const tutorialService = new TutorialService();

// Initialize on first import
tutorialService.loadProgressFromStorage();
