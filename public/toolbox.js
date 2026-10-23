(() => {
    'use strict';

    const form = document.getElementById('toolbox-form');
    if (!form) return;

    const folder = document.getElementById('output-folder');
    const quantity = document.getElementById('quantity');
    const gammaF = quantity.querySelector('option[value="gammaf"]');
    const submit = document.getElementById('toolbox-submit');
    const progress = document.getElementById('toolbox-progress');

    const updateProfileRequirement = () => {
        const hasProfile =
            folder.selectedOptions[0]?.dataset.hasProfile === 'true';
        gammaF.disabled = !hasProfile;
        if (!hasProfile && quantity.value === 'gammaf') {
            quantity.value = 'di';
        }
    };

    folder.addEventListener('change', updateProfileRequirement);
    updateProfileRequirement();

    form.addEventListener('submit', () => {
        submit.disabled = true;
        submit.textContent = '正在读取数据并生成图…';
        progress.textContent =
            '计算可能需要一些时间，请保持此页面打开。完成后会显示预览和下载链接。';
    });
})();
