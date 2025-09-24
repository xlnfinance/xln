/**
 * Test script for fintech-level type safety
 * Verifies our validation functions catch undefined routing identifiers
 */

import { validateEntityInput, validateEntityOutput, validatePaymentRoute } from './src/validation-utils';

function testTypeSafety() {
  console.log('🧪 Testing Fintech-Level Type Safety');
  console.log('====================================\n');

  // Test 1: Valid EntityInput should pass
  console.log('Test 1: Valid EntityInput validation');
  try {
    const validInput = {
      entityId: '0x0000000000000000000000000000000000000000000000000000000000000001',
      signerId: 's1',
      entityTxs: []
    };
    const result = validateEntityInput(validInput);
    console.log('✅ Valid EntityInput passed validation');
  } catch (error) {
    console.error('❌ Valid EntityInput failed:', (error as Error).message);
    process.exit(1);
  }

  // Test 2: EntityInput with undefined entityId should fail
  console.log('\nTest 2: EntityInput with undefined entityId');
  try {
    const invalidInput = {
      entityId: undefined,
      signerId: 's1',
      entityTxs: []
    };
    validateEntityInput(invalidInput);
    console.error('❌ Should have failed but passed!');
    process.exit(1);
  } catch (error) {
    console.log('✅ Correctly caught undefined entityId:', (error as Error).message);
  }

  // Test 3: EntityInput with undefined signerId should fail
  console.log('\nTest 3: EntityInput with undefined signerId');
  try {
    const invalidInput = {
      entityId: '0x0000000000000000000000000000000000000000000000000000000000000001',
      signerId: undefined,
      entityTxs: []
    };
    validateEntityInput(invalidInput);
    console.error('❌ Should have failed but passed!');
    process.exit(1);
  } catch (error) {
    console.log('✅ Correctly caught undefined signerId:', (error as Error).message);
  }

  // Test 4: Valid payment route should pass
  console.log('\nTest 4: Valid payment route validation');
  try {
    const validRoute = [
      '0x0000000000000000000000000000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000000000000000000000000000002'
    ];
    const result = validatePaymentRoute(validRoute);
    console.log('✅ Valid payment route passed validation');
  } catch (error) {
    console.error('❌ Valid payment route failed:', (error as Error).message);
    process.exit(1);
  }

  // Test 5: Payment route with undefined entity should fail
  console.log('\nTest 5: Payment route with undefined entity');
  try {
    const invalidRoute = [
      '0x0000000000000000000000000000000000000000000000000000000000000001',
      undefined,
      '0x0000000000000000000000000000000000000000000000000000000000000003'
    ];
    validatePaymentRoute(invalidRoute);
    console.error('❌ Should have failed but passed!');
    process.exit(1);
  } catch (error) {
    console.log('✅ Correctly caught undefined entity in route:', (error as Error).message);
  }

  // Test 6: Empty payment route should fail
  console.log('\nTest 6: Empty payment route');
  try {
    const emptyRoute: any[] = [];
    validatePaymentRoute(emptyRoute);
    console.error('❌ Should have failed but passed!');
    process.exit(1);
  } catch (error) {
    console.log('✅ Correctly caught empty route:', (error as Error).message);
  }

  console.log('\n🎉 All type safety tests PASSED!');
  console.log('✅ Fintech-level validation is working correctly');
  console.log('✅ Undefined routing identifiers are properly caught');
  console.log('✅ Payment route validation is robust');
  console.log('\n🛡️ Financial routing integrity is now guaranteed!');
}

testTypeSafety();