
FROM nvcr.io/nvidia/rapidsai/notebooks:25.10-cuda13-py3.13

# 设置工作目录
WORKDIR /home/rapids/notebooks/playbook

# 复制关键脚本
COPY setup/setup_playbook.sh .

# 确保脚本可执行
RUN chmod +x setup_playbook.sh

# 配置入口点
ENTRYPOINT ["./setup_playbook.sh"]
