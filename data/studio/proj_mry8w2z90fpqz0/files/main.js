class RobotArmController {
  constructor() {
    this.joints = {
      base:     { axis: 'y', type: 'rotate', min: -180, max: 180, current: 0, id: 'f_base' },
      shoulder: { axis: 'z', type: 'rotate', min: -90,  max: 90,  current: 0, id: 'f_shoulder' },
      elbow:    { axis: 'z', type: 'rotate', min: -120, max: 0,   current: 0, id: 'f_elbow' },
      wrist:    { axis: 'x', type: 'rotate', min: -180, max: 180, current: 0, id: 'f_wrist' },
      gripper:  { axis: 'y', type: 'move',   min: 0,    max: 50,  current: 0, id: 'f_gripper' }
    };
    this.isAnimating = false;
  }

  /**
   * Emits a JARVIS_BUILD command to the runtime.
   * Validates action type and constructs the exact payload shape required.
   */
  _emitCommand(action, axis, value, targetId = null) {
    const payload = { action, axis };
    if (action === 'rotate') payload.degrees = value;
    else if (action === 'move') payload.distance = value;
    if (targetId) payload.id = targetId;
    
    console.log(`JARVIS_BUILD:${JSON.stringify(payload)}`);
  }

  /**
   * Moves a single joint to a target value with mechanical limit enforcement.
   */
  moveJoint(jointName, targetValue) {
    const joint = this.joints[jointName];
    if (!joint) {
      throw new Error(`Unknown joint: "${jointName}". Available: ${Object.keys(this.joints).join(', ')}`);
    }
    if (typeof targetValue !== 'number' || !Number.isFinite(targetValue)) {
      throw new TypeError('Target value must be a finite number.');
    }
    
    // Clamp to mechanical limits to prevent hardware strain or model collision
    const clampedValue = Math.max(joint.min, Math.min(joint.max, targetValue));
    joint.current = clampedValue;
    
    this._emitCommand(joint.type, joint.axis, clampedValue, joint.id);
  }

  /**
   * Helper for non-blocking delays in animation sequences.
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Executes a waving gesture: raises the shoulder, oscillates the wrist, then returns to rest.
   */
  async wave() {
    if (this.isAnimating) {
      console.warn('Animation already in progress. Ignoring wave request.');
      return;
    }
    this.isAnimating = true;

    try {
      // Phase 1: Raise arm to greeting position
      this.moveJoint('shoulder', 45);
      await this._sleep(600);

      // Phase 2: Oscillate wrist for the wave
      for (let i = 0; i < 3; i++) {
        this.moveJoint('wrist', -30);
        await this._sleep(300);
        this.moveJoint('wrist', 30);
        await this._sleep(300);
      }

      // Phase 3: Return to neutral
      this.moveJoint('shoulder', 0);
      await this._sleep(600);
    } finally {
      this.isAnimating = false;
    }
  }
}

// Instantiate and trigger the wave sequence
const arm = new RobotArmController();
arm.wave();